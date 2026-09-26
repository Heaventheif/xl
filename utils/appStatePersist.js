
import crypto from "node:crypto";

import fs from "node:fs";

import path from "node:path";

import { isConnected as isDBConnected, loadAppStateFromDB, saveAppStateToDB } from "../db/index.js";

export const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1e3;

export const EXPIRY_CRITICAL_MS = 3 * 24 * 60 * 60 * 1e3;

const REQUIRED_COOKIES = [ "c_user", "xs" ];

const SESSION_COOKIES = [ "c_user", "xs", "fr", "sb", "datr", "wd", "locale" ];

const CRITICAL_COOKIES = [ "c_user", "xs" ];

const REFRESHABLE_COOKIES = [ "fr", "sb" ];

const ALGO = "aes-256-gcm";

const IV_LEN = 12;

const TAG_LEN = 16;

const KEY_VERSION = 1;

let _inMemoryState = null;

let _inMemoryHash = null;

let _lastSaveTimestamp = 0;
let _encryptionKey, _encryptionRaw;

function _getEncryptionKey() {
    const raw = process.env.APPSTATE_ENCRYPTION_KEY;
    if (!raw) {
        if (_encryptionRaw !== "") console.warn("[APPSTATE] ⚠️ APPSTATE_ENCRYPTION_KEY not set — disk persistence is disabled.");
        _encryptionRaw = ""; return null;
    }
    if (raw !== _encryptionRaw) {
        _encryptionRaw = raw;
        _encryptionKey = crypto.pbkdf2Sync(raw, "fca-unofficial-appstate-salt-v1", 1e5, 32, "sha256");
    }
    return _encryptionKey;
}

function _encrypt(plaintext, key) {
    if (!key) return null;
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([ cipher.update(plaintext, "utf8"), cipher.final() ]);
    const tag = cipher.getAuthTag();
    const vBuf = Buffer.alloc(1);
    vBuf.writeUInt8(KEY_VERSION, 0);
    return Buffer.concat([ vBuf, iv, tag, enc ]).toString("base64");
}

function _decrypt(blob, key) {
    if (!key) throw new Error("No encryption key available");
    const buf = Buffer.from(blob, "base64");
    if (buf.length < 29) throw new Error("Encrypted blob too short");
    const _version = buf.readUInt8(0);
    const iv = buf.subarray(1, 1 + IV_LEN);
    const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const enc = buf.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([ decipher.update(enc), decipher.final() ]).toString("utf8");
}

const APPSTATE_FILE = path.resolve(process.env.APPSTATE_FILE || ".appstate.enc");

export function saveAppStateToDisk(state) {
    const key = _getEncryptionKey();
    if (!key) return false;
    if (!_validateAppState(state)) return false;
    try {
        const plaintext = JSON.stringify(_normalizeAppState(state));
        const blob = _encrypt(plaintext, key);
        const tempFile = `${APPSTATE_FILE}.tmp-${process.pid}`;
        fs.writeFileSync(tempFile, blob, "utf8");
        fs.renameSync(tempFile, APPSTATE_FILE);
        if (isDBConnected()) void saveAppStateToDB(blob, 1);
        console.log(`[APPSTATE] 🔒 Encrypted AppState saved to disk (${state.length} cookies)`);
        return true;
    } catch (e) {
        console.warn(`[APPSTATE] ⚠️  Failed to write encrypted file: ${e.message}`);
        return false;
    }
}

export function loadAppStateFromDisk() {
    const key = _getEncryptionKey();
    if (!key) return null;
    if (!fs.existsSync(APPSTATE_FILE)) return null;
    try {
        const blob = fs.readFileSync(APPSTATE_FILE, "utf8").trim();
        const plaintext = _decrypt(blob, key);
        const state = JSON.parse(plaintext);
        if (!_validateAppState(state)) {
            console.warn("[APPSTATE] ⚠️  Decrypted file contains invalid AppState");
            return null;
        }
        console.log(`[APPSTATE] 🔓 AppState loaded from encrypted disk (${state.length} cookies)`);
        return state;
    } catch (e) {
        console.error(`[APPSTATE] ❌ Decryption failed: ${e.message}`);
        return null;
    }
}

export async function saveAppStateToMongo(state, botIndex = 1) {
    const key = _getEncryptionKey();
    const blob = key ? _encrypt(JSON.stringify(_normalizeAppState(state)), key) : null;
    return blob ? saveAppStateToDB(blob, botIndex) : false;
}

export async function loadAppStateFromMongo(botIndex = 1) {
    return loadAppStateFromDB(botIndex);
}

export async function resolveAppState(envState, _botIndex = 1) {
    if (_validateAppState(envState)) {
        const normalized = _normalizeAppState(envState);
        _updateMemoryCache(normalized);
        return {
            state: normalized,
            source: "env"
        };
    }
    if (_inMemoryState && _validateAppState(_inMemoryState)) {
        console.warn("[APPSTATE] ⚠️  Env is empty — using in-memory cache");
        return {
            state: _inMemoryState,
            source: "memory"
        };
    }
    if (isDBConnected()) {
        try {
            const blob = await loadAppStateFromDB(1);
            if (blob) {
                const state = JSON.parse(_decrypt(blob, _getEncryptionKey()));
                if (_validateAppState(state)) {
                    _updateMemoryCache(state);
                    return {
                        state: state,
                        source: "mongodb"
                    };
                }
            }
        } catch (error) {
            console.warn(`[APPSTATE] ⚠️ فشل الاسترجاع من MongoDB: ${error.message}`);
        }
    }
    const diskState = loadAppStateFromDisk();
    if (diskState) {
        _updateMemoryCache(diskState);
        return {
            state: diskState,
            source: "disk"
        };
    }
    console.error("[APPSTATE] ❌ No valid AppState found in env, memory, or disk");
    return {
        state: null,
        source: null
    };
}

export function persistAppState(state, source = "auto") {
    if (!_validateAppState(state)) {
        console.warn(`[APPSTATE] ⚠️  persistAppState: invalid state (${source})`);
        return false;
    }
    const normalized = _normalizeAppState(state);
    const newHash = _hashState(normalized);
    if (newHash === _inMemoryHash) return false;
    _updateMemoryCache(normalized, newHash);
    let saved = false;
    try {
        process.env.APPSTATE = JSON.stringify(normalized);
        globalThis.appState = normalized;
        _lastSaveTimestamp = Date.now();
        saved = true;
        console.log(`[APPSTATE] 💾 Persisted (${normalized.length} cookies | ${source})`);
    } catch (e) {
        console.warn(`[APPSTATE] ⚠️  Failed to update process.env: ${e.message}`);
    }
    saveAppStateToDisk(normalized);
    return saved;
}

export function extendCookieExpiry(state, extraDays = 60) {
    if (!Array.isArray(state)) return state;
    const extendUntil = Date.now() + extraDays * 864e5;
    return state.map((cookie => {
        if (!cookie.expires || cookie.expires === "Infinity" || cookie.expires === Infinity) return cookie;
        const expMs = cookie.expires instanceof Date ? cookie.expires.getTime() : typeof cookie.expires === "string" ? new Date(cookie.expires).getTime() : typeof cookie.expires === "number" ? cookie.expires < 1e12 ? cookie.expires * 1e3 : cookie.expires : NaN;
        if (isNaN(expMs) || expMs <= 0) return cookie;
        if (expMs < extendUntil) return {
            ...cookie,
            expires: Math.floor(extendUntil / 1e3)
        };
        return cookie;
    }));
}

export function checkAppStateExpiry(appState, warningMs = EXPIRY_WARNING_MS) {
    if (!Array.isArray(appState)) return {
        expiring: false,
        critical: false,
        minTtlMs: Infinity,
        expiresAt: null,
        expiringSoon: [],
        criticalCookies: []
    };
    const now = Date.now();
    let minTtl = Infinity, minExp = null;
    const expiringSoon = [];
    const criticalList = [];
    for (const cookie of appState) {
        const name = String(cookie?.key ?? cookie?.name ?? "");
        const exp = cookie?.expires;
        if (!exp || exp === "Infinity" || exp === Infinity) continue;
        const expMs = exp instanceof Date ? exp.getTime() : typeof exp === "string" ? new Date(exp).getTime() : typeof exp === "number" ? exp < 1e12 ? exp * 1e3 : exp : NaN;
        if (isNaN(expMs) || expMs <= 0) continue;
        const ttl = expMs - now;
        if (ttl < minTtl) {
            minTtl = ttl;
            minExp = new Date(expMs);
        }
        if (ttl < warningMs && SESSION_COOKIES.includes(name)) {
            const daysLeft = Math.round(ttl / 864e5);
            expiringSoon.push(`${name}(${daysLeft}d)`);
            if (ttl < EXPIRY_CRITICAL_MS && CRITICAL_COOKIES.includes(name)) criticalList.push(name);
        }
    }
    if (criticalList.length > 0) console.error(`[APPSTATE] 🚨 Critical cookies near expiry: ${criticalList.join(", ")}`); else if (expiringSoon.length > 0) console.warn(`[APPSTATE] ⏰ Cookies expiring soon: ${expiringSoon.join(", ")}`);
    return {
        expiring: minTtl < warningMs,
        critical: criticalList.length > 0,
        minTtlMs: minTtl === Infinity ? Infinity : Math.max(0, minTtl),
        expiresAt: minExp,
        expiringSoon: expiringSoon,
        criticalCookies: criticalList
    };
}

export function getSessionInfo(appState) {
    if (!Array.isArray(appState)) return null;
    const find = names => {
        for (const name of names) {
            const c = appState.find((c => (c?.key ?? c?.name) === name));
            if (c) return c.value;
        }
        return null;
    };
    return {
        uid: find([ "c_user", "i_user" ]),
        cookieCount: appState.length,
        hasFr: !!find([ "fr" ]),
        hasXs: !!find([ "xs" ]),
        lastSaved: _lastSaveTimestamp ? new Date(_lastSaveTimestamp).toISOString() : null
    };
}

function _validateAppState(state) {
    if (!Array.isArray(state) || state.length === 0) return false;
    const keys = new Set(state.map((c => String(c?.key ?? c?.name ?? ""))));
    return REQUIRED_COOKIES.every((k => keys.has(k)));
}

function _normalizeAppState(state) {
    return state.map((cookie => ({
        key: String(cookie?.key ?? cookie?.name ?? "").trim(),
        value: String(cookie?.value ?? ""),
        domain: cookie?.domain ?? ".facebook.com",
        path: cookie?.path ?? "/",
        secure: cookie?.secure ?? true,
        httpOnly: cookie?.httpOnly ?? false,
        expires: cookie?.expires ?? "Infinity"
    }))).filter((c => c.key));
}

function _hashState(state) {
    try {
        const sig = state.map((c => `${c.key}=${c.value}`)).join("|");
        return crypto.createHash("sha256").update(sig).digest("hex");
    } catch {
        return null;
    }
}

function _updateMemoryCache(state, hash = null) {
    _inMemoryState = state;
    _inMemoryHash = hash ?? _hashState(state);
}