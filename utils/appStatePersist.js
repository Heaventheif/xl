import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  isConnected as isDBConnected,
  loadAppStateFromDB,
  saveAppStateToDB,
} from "../db/index.js";

export const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1e3;
export const EXPIRY_CRITICAL_MS = 3 * 24 * 60 * 60 * 1e3;

const REQUIRED_COOKIES = ["c_user", "xs"];
const SESSION_COOKIES = ["c_user", "xs", "fr", "sb", "datr", "wd", "locale"];
const CRITICAL_COOKIES = ["c_user", "xs"];
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_VERSION = 1;

function _sourceFile() {
  return path.resolve(process.env.APPSTATE_FILE || "appstate.json");
}

function _encryptedFile() {
  return path.resolve(process.env.APPSTATE_PERSIST_FILE || ".appstate.enc");
}

let _inMemoryState = null;
let _inMemoryHash = null;
let _lastSaveTimestamp = 0;
let _encryptionKey = null;
let _encryptionRaw = null;
let _warnedMissingKey = false;

function _getEncryptionKey() {
  const raw = String(process.env.APPSTATE_ENCRYPTION_KEY || "");
  if (!raw) {
    if (!_warnedMissingKey) {
      _warnedMissingKey = true;
      if (isDBConnected()) {
        console.warn("[APPSTATE] ⚠️ APPSTATE_ENCRYPTION_KEY غير مضبوط — حفظ AppState في MongoDB مشفّر متوقف.");
      }
    }
    return null;
  }
  if (raw !== _encryptionRaw) {
    _encryptionRaw = raw;
    _encryptionKey = crypto.pbkdf2Sync(
      raw,
      "sunkenbot-appstate-salt-v2",
      120_000,
      32,
      "sha256"
    );
  }
  return _encryptionKey;
}

function _encrypt(plaintext, key) {
  if (!key) return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = Buffer.from([KEY_VERSION]);
  return Buffer.concat([version, iv, tag, enc]).toString("base64");
}

function _decrypt(blob, key) {
  if (!key) throw new Error("APPSTATE_ENCRYPTION_KEY غير متاح");
  const buf = Buffer.from(String(blob || ""), "base64");
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new Error("Encrypted AppState غير صالح");
  const version = buf.readUInt8(0);
  if (version !== KEY_VERSION) throw new Error(`Encrypted AppState version ${version} غير مدعومة`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const enc = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function _normalizeAppState(state) {
  return state
    .map((cookie) => {
      const expires = cookie?.expires ?? cookie?.expirationDate ?? "Infinity";
      return {
        key: String(cookie?.key ?? cookie?.name ?? "").trim(),
        value: String(cookie?.value ?? ""),
        domain: cookie?.domain ?? ".facebook.com",
        path: cookie?.path ?? "/",
        secure: cookie?.secure ?? true,
        httpOnly: cookie?.httpOnly ?? false,
        sameSite: cookie?.sameSite ?? undefined,
        expires,
      };
    })
    .filter((cookie) => cookie.key && cookie.value)
    .map((cookie) => {
      if (cookie.sameSite == null) delete cookie.sameSite;
      return cookie;
    });
}

function _validateAppState(state) {
  if (!Array.isArray(state) || state.length === 0) return false;
  const keys = new Set(state.map((c) => String(c?.key ?? c?.name ?? "")));
  return REQUIRED_COOKIES.every((key) => keys.has(key));
}

function _hashState(state) {
  try {
    return crypto
      .createHash("sha256")
      .update(state.map((c) => `${c.key}=${c.value}`).join("|"))
      .digest("hex");
  } catch {
    return null;
  }
}

function _updateMemoryCache(state, hash = null) {
  _inMemoryState = state;
  _inMemoryHash = hash ?? _hashState(state);
}

function _writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
}

function _readDirectFile() {
  const file = _sourceFile();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const state = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (!_validateAppState(state)) throw new Error("AppState file لا يحتوي c_user و xs");
    const normalized = _normalizeAppState(state);
    console.log(`[APPSTATE] 📄 Loaded ${normalized.length} cookies from ${path.basename(file)}`);
    return normalized;
  } catch (error) {
    console.warn(`[APPSTATE] ⚠️ تعذر قراءة ${file}: ${error.message}`);
    return null;
  }
}

function _writeDirectFile(state) {
  const enabled = String(process.env.APPSTATE_WRITE_FILE ?? "true").trim().toLowerCase() !== "false";
  const file = _sourceFile();
  if (!enabled || !file) return false;
  try {
    _writeJsonAtomic(file, state);
    return true;
  } catch (error) {
    console.warn(`[APPSTATE] ⚠️ فشل حفظ الملف المباشر: ${error.message}`);
    return false;
  }
}

function _writeEncryptedFile(blob) {
  if (!blob) return false;
  try {
    _writeJsonAtomic(_encryptedFile(), blob);
    return true;
  } catch (error) {
    console.warn(`[APPSTATE] ⚠️ فشل حفظ AppState المشفّر: ${error.message}`);
    return false;
  }
}

function _readEncryptedFile() {
  const key = _getEncryptionKey();
  const file = _encryptedFile();
  if (!key || !fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const blob = JSON.parse(raw);
    const state = JSON.parse(_decrypt(blob, key));
    if (!_validateAppState(state)) return null;
    return _normalizeAppState(state);
  } catch (error) {
    console.warn(`[APPSTATE] ⚠️ فشل فك AppState المشفّر: ${error.message}`);
    return null;
  }
}

export function saveAppStateToDisk(state) {
  if (!_validateAppState(state)) return false;
  const normalized = _normalizeAppState(state);
  const key = _getEncryptionKey();
  let saved = _writeDirectFile(normalized);
  if (key) {
    const blob = _encrypt(JSON.stringify(normalized), key);
    saved = _writeEncryptedFile(blob) || saved;
  }
  if (saved) console.log(`[APPSTATE] 💾 Persisted (${normalized.length} cookies)`);
  return saved;
}

export function loadAppStateFromDisk() {
  const direct = _readDirectFile();
  if (direct) return direct;
  return _readEncryptedFile();
}

export async function saveAppStateToMongo(state, botIndex = 1) {
  if (!_validateAppState(state) || !isDBConnected()) return false;
  const key = _getEncryptionKey();
  if (!key) return false;
  const normalized = _normalizeAppState(state);
  const blob = _encrypt(JSON.stringify(normalized), key);
  return Boolean(blob && await saveAppStateToDB(blob, botIndex));
}

export async function loadAppStateFromMongo(botIndex = 1) {
  const key = _getEncryptionKey();
  if (!key || !isDBConnected()) return null;
  try {
    const blob = await loadAppStateFromDB(botIndex);
    if (!blob) return null;
    const state = JSON.parse(_decrypt(blob, key));
    if (!_validateAppState(state)) return null;
    return _normalizeAppState(state);
  } catch (error) {
    console.warn(`[APPSTATE] ⚠️ فشل استرجاع MongoDB: ${error.message}`);
    return null;
  }
}

export async function resolveAppState(envState, botIndex = 1) {
  if (_validateAppState(envState)) {
    const normalized = _normalizeAppState(envState);
    _updateMemoryCache(normalized);
    return { state: normalized, source: "env" };
  }

  if (_inMemoryState && _validateAppState(_inMemoryState)) {
    return { state: _inMemoryState, source: "memory" };
  }

  // MongoDB is checked before the direct file so a previously refreshed
  // session can survive a redeploy even when appstate.json is old.
  const mongoState = await loadAppStateFromMongo(botIndex);
  if (mongoState) {
    _updateMemoryCache(mongoState);
    return { state: mongoState, source: "mongodb" };
  }

  const diskState = loadAppStateFromDisk();
  if (diskState) {
    _updateMemoryCache(diskState);
    return { state: diskState, source: "file" };
  }

  return { state: null, source: null };
}

export function persistAppState(state, source = "auto", botIndex = 1) {
  if (!_validateAppState(state)) {
    console.warn(`[APPSTATE] ⚠️ persistAppState: invalid state (${source})`);
    return false;
  }
  const normalized = _normalizeAppState(state);
  const newHash = _hashState(normalized);
  if (newHash === _inMemoryHash) return false;

  _updateMemoryCache(normalized, newHash);
  _lastSaveTimestamp = Date.now();
  globalThis.appState = normalized;

  try {
    // Keep compatibility with code that explicitly reads process.env.APPSTATE,
    // but only write it when requested; this avoids a large duplicated secret
    // in the environment object for normal deployments.
    if (String(process.env.APPSTATE_SYNC_ENV || "false").toLowerCase() === "true") {
      process.env.APPSTATE = JSON.stringify(normalized);
    }
  } catch (_) {}

  saveAppStateToDisk(normalized);
  if (isDBConnected()) void saveAppStateToMongo(normalized, botIndex);

  console.log(`[APPSTATE] ✅ Persisted (${normalized.length} cookies | ${source})`);
  return true;
}

export function checkAppStateExpiry(appState, warningMs = EXPIRY_WARNING_MS) {
  if (!Array.isArray(appState)) {
    return { expiring: false, critical: false, minTtlMs: Infinity, expiresAt: null, expiringSoon: [], criticalCookies: [] };
  }
  const now = Date.now();
  let minTtl = Infinity;
  let minExp = null;
  const expiringSoon = [];
  const criticalCookies = [];

  for (const cookie of appState) {
    const name = String(cookie?.key ?? cookie?.name ?? "");
    const exp = cookie?.expires ?? cookie?.expirationDate;
    if (!exp || exp === "Infinity" || exp === Infinity) continue;

    let expMs = NaN;
    if (exp instanceof Date) expMs = exp.getTime();
    else if (typeof exp === "number") expMs = exp < 1e12 ? exp * 1e3 : exp;
    else if (typeof exp === "string") expMs = new Date(exp).getTime();
    if (!Number.isFinite(expMs) || expMs <= 0) continue;

    const ttl = expMs - now;
    if (ttl < minTtl) {
      minTtl = ttl;
      minExp = new Date(expMs);
    }
    if (ttl < warningMs && SESSION_COOKIES.includes(name)) {
      expiringSoon.push(`${name}(${Math.round(ttl / 864e5)}d)`);
      if (ttl < EXPIRY_CRITICAL_MS && CRITICAL_COOKIES.includes(name)) criticalCookies.push(name);
    }
  }

  return {
    expiring: minTtl < warningMs,
    critical: criticalCookies.length > 0,
    minTtlMs: minTtl === Infinity ? Infinity : Math.max(0, minTtl),
    expiresAt: minExp,
    expiringSoon,
    criticalCookies,
  };
}

export function getSessionInfo(appState) {
  if (!Array.isArray(appState)) return null;
  const find = (names) => {
    for (const name of names) {
      const cookie = appState.find((c) => (c?.key ?? c?.name) === name);
      if (cookie) return cookie.value;
    }
    return null;
  };
  return {
    uid: find(["c_user", "i_user"]),
    cookieCount: appState.length,
    hasFr: Boolean(find(["fr"])),
    hasXs: Boolean(find(["xs"])),
    lastSaved: _lastSaveTimestamp ? new Date(_lastSaveTimestamp).toISOString() : null,
  };
}
