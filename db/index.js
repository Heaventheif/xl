
import { MongoClient } from "mongodb";

import { isTransientError, withRetry } from "../utils/resilience.js";

let client = null;

let database = null;

let state = {
    connected: false,
    mode: "memory",
    lastError: null,
    lastOperationAt: null
};

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
    store.delete(key);
    store.set(key, value);
    return value;
}

function mongoUri() {
    return String(process.env.MONGO_URI || process.env.MONGODB_URI || "").trim();
}

export function getMongoDb() {
    return database;
}

function touch() {
    state.lastOperationAt = Date.now();
}

export async function connectDB() {
    const uri = mongoUri();
    if (!uri) {
        global.db = null;
        state = {
            ...state,
            connected: false,
            mode: "memory",
            lastError: null
        };
        console.warn("[DB] MONGO_URI غير مضبوط — سيتم استخدام الذاكرة");
        return false;
    }
    try {
        await withRetry((async () => {
            client = client || new MongoClient(uri, {
                serverSelectionTimeoutMS: 8e3,
                connectTimeoutMS: 8e3,
                maxPoolSize: 4,
                minPoolSize: 0,
                maxIdleTimeMS: 60_000,
                retryReads: true,
                retryWrites: true
            });
            await client.connect();
            database = client.db(process.env.MONGO_DB_NAME || "sunkenbot");
            await database.command({
                ping: 1
            });
        }), {
            label: "mongodb-connect",
            retries: 3,
            shouldRetry: isTransientError
        });
        global.db = database;
        state = {
            connected: true,
            mode: "mongodb",
            lastError: null,
            lastOperationAt: Date.now()
        };
        console.log("[DB] MongoDB متصل");
        return true;
    } catch (error) {
        database = null;
        global.db = null;
        state = {
            ...state,
            connected: false,
            mode: "memory",
            lastError: error.message,
            lastOperationAt: Date.now()
        };
        console.warn(`[DB] تعذر الاتصال بـ MongoDB — سيتم استخدام الذاكرة: ${error.message}`);
        return false;
    }
}

export async function disconnectDB() {
    try {
        await (client?.close());
    } catch (_) {}
    client = null;
    database = null;
    global.db = null;
    state.connected = false;
}

export async function flushAllAndDisconnect() {
    await disconnectDB();
}

export function isConnected() {
    return state.connected;
}

export function health() {
    return {
        ...state,
        lastOperationAt: state.lastOperationAt ? new Date(state.lastOperationAt).toISOString() : null
    };
}

export async function saveUserData(uid, data) {
    const id = String(uid);
    const value = {
        ...memoryUsers.get(id) || {},
        ...data
    };
    boundedSet(memoryUsers, id, value, MAX_MEMORY_USERS);
    if (!database) return true;
    try {
        await database.collection("bot_users").updateOne({
            _id: id
        }, {
            $set: {
                data: value,
                updatedAt: new Date
            }
        }, {
            upsert: true
        });
        touch();
        return true;
    } catch (error) {
        state.lastError = error.message;
        return false;
    }
}

export async function loadUserData(uid) {
    const id = String(uid);
    if (!database) return boundedGet(memoryUsers, id) || null;
    try {
        const row = await database.collection("bot_users").findOne({
            _id: id
        });
        const data = row?.data || boundedGet(memoryUsers, id) || null;
        if (data) boundedSet(memoryUsers, id, data, MAX_MEMORY_USERS);
        touch();
        return data;
    } catch (error) {
        state.lastError = error.message;
        return memoryUsers.get(id) || null;
    }
}

export async function addBanDB(type, id, by = null, reason = null) {
    const key = `${type}:${id}`;
    const value = {
        _id: key,
        type: type,
        id: String(id),
        by: by,
        reason: reason,
        createdAt: new Date
    };
    boundedSet(memoryBans, key, value, MAX_MEMORY_BANS);
    if (!database) return true;
    try {
        await database.collection("bot_bans").replaceOne({
            _id: key
        }, value, {
            upsert: true
        });
        touch();
        return true;
    } catch (error) {
        state.lastError = error.message;
        return false;
    }
}

export async function removeBanDB(type, id) {
    const key = `${type}:${id}`;
    memoryBans.delete(key);
    if (!database) return true;
    try {
        await database.collection("bot_bans").deleteOne({
            _id: key
        });
        touch();
        return true;
    } catch (error) {
        state.lastError = error.message;
        return false;
    }
}

export async function saveAppStateToDB(blob, botIndex = 1) {
    if (!database || !blob) return false;
    try {
        await database.collection("bot_appstate").updateOne({
            _id: String(botIndex)
        }, {
            $set: {
                encryptedBlob: blob,
                updatedAt: new Date
            }
        }, {
            upsert: true
        });
        touch();
        return true;
    } catch (error) {
        state.lastError = error.message;
        return false;
    }
}

export async function loadAppStateFromDB(botIndex = 1) {
    if (!database) return null;
    try {
        const row = await database.collection("bot_appstate").findOne({
            _id: String(botIndex)
        });
        touch();
        return row?.encryptedBlob || null;
    } catch (error) {
        state.lastError = error.message;
        return null;
    }
}

export default {
    connectDB: connectDB,
    disconnectDB: disconnectDB,
    flushAllAndDisconnect: flushAllAndDisconnect,
    getMongoDb: getMongoDb,
    isConnected: isConnected,
    health: health,
    saveUserData: saveUserData,
    loadUserData: loadUserData,
    addBanDB: addBanDB,
    removeBanDB: removeBanDB,
    saveAppStateToDB: saveAppStateToDB,
    loadAppStateFromDB: loadAppStateFromDB
};