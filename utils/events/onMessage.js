import { handleMessage, handleEvent, handleReaction, invalidateThreadInfoCache } from "../core/Router.js";
// ─── Bounded concurrency queue ───────────────────────────────────
// Prevents unbounded concurrent command execution that can cause
// unhandled-rejection crashes under Node 20+ and Meta rate-limiting.
const MAX_CONCURRENT = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_COMMANDS || "5", 10) || 5);
const MAX_PENDING = Math.max(10, Number.parseInt(process.env.MAX_PENDING_COMMANDS || "100", 10) || 100);
let _activeSlots = 0;
const _pendingQueue = [];

function _enqueue(fn) {
  if (_pendingQueue.length >= MAX_PENDING) {
    return Promise.reject(new Error("command queue full"));
  }
  return new Promise((resolve, reject) => {
    _pendingQueue.push({ fn, resolve, reject });
    _drainQueue();
  });
}

function _drainQueue() {
  while (_activeSlots < MAX_CONCURRENT && _pendingQueue.length > 0) {
    const { fn, resolve, reject } = _pendingQueue.shift();
    _activeSlots++;
    Promise.resolve().then(fn)
      .then(resolve, reject)
      .finally(() => { _activeSlots--; _drainQueue(); });
  }
}
// ────────────────────────────────────────────────────────────────

export function dispatchMqttEvent(api, event, label) {
  if (global.isBanned(event.threadID, event.senderID ?? event.userID)) return;

  // Group-only policy: ignore DMs and message requests without replying or accepting them.
  if (!event.isGroup) return;

  // [FIX ADMIN CACHE] إبطال cache المجموعة فوراً عند تغيير المشرفين
  if (event.logMessageType === "change_thread_admins" && event.threadID) {
    invalidateThreadInfoCache(event.threadID);
  }

  // [FIX CACHE EVICT] Invalidate thread cache when the bot itself is removed
  // from a group — otherwise stale data lingers for up to 5 min and causes
  // confusing "not an admin" errors if the bot rejoins the same group.
  if (
    event.logMessageType === "remove_from_group" &&
    event.threadID &&
    event.participantIDs?.some(id => String(id) === String(api.getCurrentUserID?.()))
  ) {
    invalidateThreadInfoCache(event.threadID);
    console.log(`[CACHE] 🗑️ Bot أُخرج من المجموعة ${event.threadID} — cache مُبطَل.`);
  }

  if (["message", "message_reply", "log", "event"].includes(event.type)) {
    // تمييز الرسالة كمقروءة — نؤخّره 800ms لضمان أن mqttClient جاهز بعد listenMqtt
    if (["message", "message_reply"].includes(event.type) && event.threadID) {
      // BUG-06 FIX: فحص __lifecycleStopped يمنع race condition إذا أُوقف البوت
      // خلال الـ 800ms قبل تنفيذ markAsRead
      api.__markReadTimers ||= new Set();
      const markReadTimer = setTimeout(() => {
        api.__markReadTimers.delete(markReadTimer);
        if (api.__lifecycleStopped) return;
        try {
          if (typeof api.markAsRead === "function") {
            api.markAsRead(event.threadID, true, (err) => {
              if (err) {
                const msg = err.message || String(err);
                if (!/connection closed/i.test(msg))
                  console.warn(`[MARK-READ:${label}]`, msg);
              }
            });
          }
        } catch (e) {
          console.warn(`[MARK-READ:${label}]`, e.message);
        }
      }, 800);
      api.__markReadTimers.add(markReadTimer);
    }
    // Route through bounded queue — prevents unbounded parallelism and ensures
    // every async path has a top-level catch that never terminates the process.
    _enqueue(async () => {
      try {
        await handleEvent(api, event);
      } catch (e) {
        console.error(`[EVENT ERR:${label}]`, e?.message ?? e);
      }
      try {
        await handleMessage(api, event);
      } catch (e) {
        console.error(`[MSG ERR:${label}]`, e?.message ?? e);
      }
    }).catch(e => console.error(`[QUEUE ERR:${label}]`, e?.message ?? e));
  } else if (event.type === "message_reaction") {
    try {
      handleReaction(api, event);
    } catch (e) {
      console.error(`[REACTION ERR:${label}]`, e?.message ?? e);
    }
  }
}

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-events-on-message',
  meta: { category: 'event', path: 'utils/events/onMessage.js' },
  setup(_ctx) {
    // provides: dispatchMqttEvent
  },
};
