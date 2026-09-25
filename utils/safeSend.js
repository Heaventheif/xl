
const MIN_SEND_GAP_MS = 1500;

const PRIORITY_SEND_GAP_MS = 800;

const JITTER_RANGE_MS = 400;

const _threadGates = new Map;

function _gate(key, gapMs) {
    let gate = _threadGates.get(key);
    if (!gate) {
        gate = {
            promise: Promise.resolve(),
            lastSendAt: 0
        };
        _threadGates.set(key, gate);
    }
    return gate;
}

const MAX_FB_MSG_LEN = 19500;

function splitMessage(text) {
    if (text.length <= MAX_FB_MSG_LEN) return [ text ];
    const parts = [];
    let start = 0;
    while (start < text.length) {
        let end = start + MAX_FB_MSG_LEN;
        if (end < text.length) {
            const lastNl = text.lastIndexOf("\n", end);
            if (lastNl > start) end = lastNl + 1;
        }
        parts.push(text.slice(start, end));
        start = end;
    }
    return parts;
}

function gatedSend(api, body, threadID, callback, messageID) {
    if (typeof body === "string" && body.length > MAX_FB_MSG_LEN) {
        const parts = splitMessage(body);
        console.warn(`[SEND] ⚠️ رسالة طويلة (${body.length} حرف) — تُقسَّم إلى ${parts.length} جزء.`);
        let chain = Promise.resolve();
        parts.forEach(((part, i) => {
            const isLast = i === parts.length - 1;
            chain = chain.then((() => _gatedSendRaw(api, part, threadID, isLast ? callback : undefined, isLast ? messageID : undefined)));
        }));
        return chain;
    }
    return _gatedSendRaw(api, body, threadID, callback, messageID);
}

async function _send(api, body, threadID, callback, messageID, gapMs, label) {
    const rawApi = api.__rawApi || api, key = String(threadID), gate = _gate(key, gapMs);
    const run = gate.promise.then(async () => {
        const wait = gapMs + Math.floor(Math.random() * JITTER_RANGE_MS) - (JITTER_RANGE_MS >> 1) - (Date.now() - gate.lastSendAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        if (rawApi.__stealth) try { await Promise.race([rawApi.__stealth.waitIfNeeded(), new Promise(r => setTimeout(r, 25e3))]); } catch {}
        gate.lastSendAt = Date.now();
        try {
            const result = messageID !== undefined ? await rawApi.sendMessage(body, threadID, callback, messageID) : await rawApi.sendMessage(body, threadID, callback);
            rawApi.__stealth?.recordRequest?.();
            return result;
        } catch (error) {
            if (label === "SEND" && /429|405|rate.?limit|too many/i.test(String(error?.message ?? error))) {
                const backoff = 3e4 + Math.floor(Math.random() * 3e4);
                gate.lastSendAt = Date.now() + backoff;
                console.warn(`[${label}] ⚠️ rate-limited — cooldown ${Math.round(backoff / 1e3)}s`);
            }
            throw error;
        }
    });
    gate.promise = run.catch(error => console.error(`[${label}] خطأ:`, error.message));
    return run;
}

function _gatedSendRaw(api, body, threadID, callback, messageID) {
    return _send(api, body, threadID, callback, messageID, MIN_SEND_GAP_MS, "SEND");
}

function prioritySend(api, body, threadID, callback, messageID) {
    return _send(api, body, threadID, callback, messageID, PRIORITY_SEND_GAP_MS, "PRIORITY_SEND");
}

function cleanupIdleThreadGates() {
    const now = Date.now();
    let removed = 0;
    for (const [tid, g] of _threadGates.entries()) {
        if (now - g.lastSendAt > 30 * 60 * 1e3) {
            _threadGates.delete(tid);
            removed++;
        }
    }
    return removed;
}

const _wrappedApiCache = new WeakMap;

function wrapApiForSafety(api) {
    if (_wrappedApiCache.has(api)) return _wrappedApiCache.get(api);
    const wrapped = Object.create(api);
    wrapped.__rawApi = api;
    wrapped.sendMessage = (body, threadID, callback, messageID) => global.safeSend(api, body, threadID, callback, messageID);
    _wrappedApiCache.set(api, wrapped);
    return wrapped;
}

global.safeSend = gatedSend;

global.prioritySend = prioritySend;

global.wrapApiForSafety = wrapApiForSafety;

global.cleanupIdleThreadGates = cleanupIdleThreadGates;

setInterval((() => {
    const removed = cleanupIdleThreadGates();
    if (removed > 0) console.log(`[SEND] 🧹 أُزيل ${removed} gate خامل من الذاكرة.`);
}), 30 * 60 * 1e3).unref();

export { gatedSend, prioritySend, wrapApiForSafety, cleanupIdleThreadGates };

export const $plugin = {
    name: "xx-utils-safe-send",
    meta: {
        category: "utils",
        path: "utils/safeSend.js"
    },
    setup(_ctx) {}
};