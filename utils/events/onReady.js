import cache from "../cache.js";
import { cleanupOrphanTempFiles } from "../tempCleanup.js";

let cleanupTimer = null;

export function startCleanupInterval() {
  if (cleanupTimer) return cleanupTimer;
  cleanupTimer = setInterval(() => {
    const now     = Date.now();
    let   cleaned = 0;
    for (const [id, data] of Object.entries(global.Kagenou.replies)) {
      if (now - (data.timestamp || 0) > 10 * 60 * 1000) {
        delete global.Kagenou.replies[id]; cleaned++;
      }
    }
    for (const [key, exp] of global.userCooldowns.entries()) {
      if (now >= exp) { global.userCooldowns.delete(key); cleaned++; }
    }
    for (const [uid, data] of global.usersData.entries()) {
      if (data._lastSeen && now - data._lastSeen > 60 * 60 * 1000) {
        global.usersData.delete(uid); cleaned++;
      }
    }
    for (const [msgID, ts] of global._reactionTimestamps.entries()) {
      if (now - ts > 10 * 60 * 1000) {
        delete global.client.reactionListener[msgID];
        global._reactionTimestamps.delete(msgID);
        cleaned++;
      }
    }
    cleanupOrphanTempFiles();
    try { cleaned += cache.sweep(); } catch (_) {}
    try { cleaned += global.cleanupIdleThreadGates(); } catch (_) {}
    if (cleaned) console.log(`[CLEANUP] 🧹 ${cleaned} مدخلة`);
  }, 10 * 60 * 1000);
  cleanupTimer.unref?.();
  return cleanupTimer;
}

export function stopCleanupInterval() {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-events-on-ready',
  meta: { category: 'event', path: 'utils/events/onReady.js' },
  setup(_ctx) {
    // provides: startCleanupInterval
  },
};
