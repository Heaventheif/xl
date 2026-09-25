import { MongoClient } from "mongodb";
import { isTransientError, withRetry } from "../utils/resilience.js";

let client = null;
let database = null;
let monitorTimer = null;
let flushing = false;
const pendingWrites = new Map();
const MAX_PENDING_WRITES = 1000;

let state = { connected: false, mode: "memory", lastError: null, lastOperationAt: null, lastRecoveryAt: null, pendingWrites: 0 };
const memoryUsers = new Map();
const memoryBans = new Map();
const MAX_MEMORY_USERS = 2000;
const MAX_MEMORY_BANS = 1000;

function boundedSet(store, key, value, maxSize) {
  store.delete(key);
  if (store.size >= maxSize) store.delete(store.keys().next().value);
  store.set(key, value);
}
function boundedGet(store, key) {
  const value = store.get(key);
  if (value === undefined) return undefined;
  store.delete(key); store.set(key, value); return value;
}
function mongoUri() { return String(process.env.MONGO_URI || process.env.MONGODB_URI || "").trim(); }
export function getMongoDb() { return database; }
function touch() { state.lastOperationAt = Date.now(); }
function shouldPersistToMongo() { return Boolean(mongoUri()); }
function queueWrite(key, fn) {
  if (pendingWrites.has(key)) pendingWrites.delete(key);
  else if (pendingWrites.size >= MAX_PENDING_WRITES) pendingWrites.delete(pendingWrites.keys().next().value);
  pendingWrites.set(key, fn);
  state.pendingWrites = pendingWrites.size;
}
async function flushPendingWrites() {
  if (!database || flushing || pendingWrites.size === 0) return;
  flushing = true;
  try {
    for (const [key, fn] of [...pendingWrites]) {
      if (!database) break;
      try { await fn(); pendingWrites.delete(key); }
      catch (error) { state.lastError = error.message; break; }
    }
  } finally { state.pendingWrites = pendingWrites.size; flushing = false; }
}
async function ensureIndexes() {
  if (!database) return;
  await Promise.all([
    database.collection("bot_users").createIndex({ updatedAt: -1 }),
    database.collection("bot_bans").createIndex({ type: 1, id: 1 }, { unique: true }),
    database.collection("bot_appstate").createIndex({ updatedAt: -1 })
  ]);
}
async function recoverDB() {
  if (!client || !mongoUri()) return false;
  try {
    await client.db(process.env.MONGO_DB_NAME || "sunkenbot").command({ ping: 1 });
    database = client.db(process.env.MONGO_DB_NAME || "sunkenbot");
    await ensureIndexes();
    global.db = database;
    state = { ...state, connected: true, mode: "mongodb", lastError: null, lastRecoveryAt: Date.now() };
    await flushPendingWrites();
    return true;
  } catch (error) {
    state = { ...state, connected: false, mode: "memory", lastError: error.message };
    return false;
  }
}
function startMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => { void recoverDB(); }, 60_000);
  monitorTimer.unref?.();
}

export async function connectDB() {
  const uri = mongoUri();
  startMonitor();
  if (!uri) {
    global.db = null;
    state = { ...state, connected: false, mode: "memory", lastError: null };
    console.warn("[DB] MONGO_URI غير مضبوط — سيتم استخدام الذاكرة");
    return false;
  }
  try {
    await withRetry(async () => {
      client = client || new MongoClient(uri, { serverSelectionTimeoutMS: 8e3, connectTimeoutMS: 8e3, maxPoolSize: 4, minPoolSize: 0, maxIdleTimeMS: 60_000, retryReads: true, retryWrites: true });
      await client.connect();
      database = client.db(process.env.MONGO_DB_NAME || "sunkenbot");
      await database.command({ ping: 1 });
      await ensureIndexes();
    }, { label: "mongodb-connect", retries: 3, shouldRetry: isTransientError });
    global.db = database;
    state = { ...state, connected: true, mode: "mongodb", lastError: null, lastOperationAt: Date.now() };
    await flushPendingWrites();
    console.log("[DB] MongoDB متصل");
    return true;
  } catch (error) {
    state = { ...state, connected: false, mode: "memory", lastError: error.message, lastOperationAt: Date.now() };
    global.db = null;
    console.warn(`[DB] تعذر الاتصال بـ MongoDB — سيتم استخدام الذاكرة: ${error.message}`);
    return false;
  }
}
export async function disconnectDB() {
  clearInterval(monitorTimer); monitorTimer = null;
  try { await client?.close(); } catch (_) {}
  client = null; database = null; global.db = null;
  state.connected = false; state.mode = "memory";
}
export async function flushAllAndDisconnect() { await flushPendingWrites(); await disconnectDB(); }
export function isConnected() { return state.connected; }
export function health() { return { ...state, pendingWrites: pendingWrites.size, lastOperationAt: state.lastOperationAt ? new Date(state.lastOperationAt).toISOString() : null, lastRecoveryAt: state.lastRecoveryAt ? new Date(state.lastRecoveryAt).toISOString() : null }; }

export async function saveUserData(uid, data) {
  const id = String(uid); const value = { ...(memoryUsers.get(id) || {}), ...data }; boundedSet(memoryUsers, id, value, MAX_MEMORY_USERS);
  if (!database) { if (shouldPersistToMongo()) queueWrite(`user:${id}`, async () => { if (!database) throw new Error("MongoDB unavailable"); await database.collection("bot_users").updateOne({ _id: id }, { $set: { data: value, updatedAt: new Date() } }, { upsert: true }); touch(); }); return true; }
  try { await database.collection("bot_users").updateOne({ _id: id }, { $set: { data: value, updatedAt: new Date() } }, { upsert: true }); touch(); return true; }
  catch (error) { state.lastError = error.message; if (shouldPersistToMongo()) queueWrite(`user:${id}`, async () => { if (!database) throw new Error("MongoDB unavailable"); await database.collection("bot_users").updateOne({ _id: id }, { $set: { data: value, updatedAt: new Date() } }, { upsert: true }); touch(); }); return false; }
}
export async function loadUserData(uid) {
  const id = String(uid); if (!database) return boundedGet(memoryUsers, id) || null;
  try { const row = await database.collection("bot_users").findOne({ _id: id }); const data = row?.data || boundedGet(memoryUsers, id) || null; if (data) boundedSet(memoryUsers, id, data, MAX_MEMORY_USERS); touch(); return data; }
  catch (error) { state.lastError = error.message; return boundedGet(memoryUsers, id) || null; }
}
export async function addBanDB(type, id, by = null, reason = null) {
  const key = `${type}:${id}`; const value = { _id: key, type, id: String(id), by, reason, createdAt: new Date() }; boundedSet(memoryBans, key, value, MAX_MEMORY_BANS);
  if (!database) { if (shouldPersistToMongo()) queueWrite(`ban:${key}`, async () => { if (!database) throw new Error("MongoDB unavailable"); await database.collection("bot_bans").replaceOne({ _id: key }, value, { upsert: true }); touch(); }); return true; }
  try { await database.collection("bot_bans").replaceOne({ _id: key }, value, { upsert: true }); touch(); return true; }
  catch (error) { state.lastError = error.message; if (shouldPersistToMongo()) queueWrite(`ban:${key}`, async () => { if (!database) throw new Error("MongoDB unavailable"); await database.collection("bot_bans").replaceOne({ _id: key }, value, { upsert: true }); touch(); }); return false; }
}
export async function removeBanDB(type, id) {
  const key = `${type}:${id}`; memoryBans.delete(key); if (!database) { if (shouldPersistToMongo()) queueWrite(`ban:${key}`, async () => { if (!database) throw new Error("MongoDB unavailable"); await database.collection("bot_bans").deleteOne({ _id: key }); touch(); }); return true; }
  try { await database.collection("bot_bans").deleteOne({ _id: key }); touch(); return true; }
  catch (error) { state.lastError = error.message; if (shouldPersistToMongo()) queueWrite(`ban:${key}`, async () => { if (!database) throw new Error("MongoDB unavailable"); await database.collection("bot_bans").deleteOne({ _id: key }); touch(); }); return false; }
}
export async function saveAppStateToDB(blob, botIndex = 1) {
  if (!blob) return false; const key = `appstate:${botIndex}`;
  const write = async () => { await database.collection("bot_appstate").updateOne({ _id: String(botIndex) }, { $set: { encryptedBlob: blob, updatedAt: new Date() } }, { upsert: true }); touch(); };
  if (!database) { if (shouldPersistToMongo()) queueWrite(key, write); return false; }
  try { await write(); return true; } catch (error) { state.lastError = error.message; queueWrite(key, write); return false; }
}
export async function loadAppStateFromDB(botIndex = 1) {
  if (!database) return null;
  try { const row = await database.collection("bot_appstate").findOne({ _id: String(botIndex) }); touch(); return row?.encryptedBlob || null; }
  catch (error) { state.lastError = error.message; return null; }
}
export default { connectDB, disconnectDB, flushAllAndDisconnect, getMongoDb, isConnected, health, saveUserData, loadUserData, addBanDB, removeBanDB, saveAppStateToDB, loadAppStateFromDB };
