"use strict";

/**
 * Human-like pacing for outgoing messages (per account, per thread).
 *
 * Options (login/setOptions `humanize`, or `false` to disable everything):
 *   enabled          {boolean} default false (opt-in: pass `humanize: true` or an object)
 *   typing           {boolean} show typing indicator before sending (default true)
 *   readDelayMs      {[min,max]} pause before "starting to type" (default [400, 1500])
 *   msPerChar        {number}  typing speed (default 45 => ~22 chars/sec)
 *   typingMinMs      {number}  default 800
 *   typingMaxMs      {number}  default 6000
 *   jitter           {number}  0..1 random spread applied to durations (default 0.25)
 *   minGapMs         {number}  minimum gap between two messages in the same thread (default 1200)
 */

const DEFAULTS = {
    enabled: false,
    typing: true,
    readDelayMs: [400, 1500],
    msPerChar: 45,
    typingMinMs: 800,
    typingMaxMs: 6000,
    jitter: 0.25,
    minGapMs: 1200
};

function resolve(options) {
    const raw = options && options.humanize;
    if (raw === false) return Object.assign({}, DEFAULTS, { enabled: false });
    if (raw === true) return Object.assign({}, DEFAULTS, { enabled: true });
    if (raw && typeof raw === "object") return Object.assign({}, DEFAULTS, { enabled: true }, raw);
    return Object.assign({}, DEFAULTS);
}

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jittered(ms, jitter) {
    return Math.max(0, Math.round(ms * (1 + rand(-jitter, jitter))));
}

function typingDuration(cfg, text) {
    const len = text ? String(text).length : 0;
    const base = Math.min(cfg.typingMaxMs, Math.max(cfg.typingMinMs, len * cfg.msPerChar));
    return jittered(base, cfg.jitter);
}

/**
 * Serialize sends per thread so ordering is preserved and the minimum gap is respected.
 * `task` runs once its turn comes; the returned promise settles with the task result.
 */
function createPacer(ctx) {
    const chains = new Map(); // threadID -> Promise tail
    const lastSent = new Map(); // threadID -> timestamp

    return function run(threadID, task) {
        const cfg = resolve(ctx.globalOptions);
        if (!cfg.enabled) return task(cfg);

        const key = String(threadID);
        const prev = chains.get(key) || Promise.resolve();
        const next = prev.catch(() => { }).then(async () => {
            const wait = (lastSent.get(key) || 0) + jittered(cfg.minGapMs, cfg.jitter) - Date.now();
            if (wait > 0) await sleep(wait);
            try {
                return await task(cfg);
            } finally {
                lastSent.set(key, Date.now());
            }
        });
        chains.set(key, next);
        next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => { });
        return next;
    };
}

module.exports = { resolve, createPacer, typingDuration, sleep, rand, DEFAULTS };
