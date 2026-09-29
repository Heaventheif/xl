import { buildMessageAPI, buildCommandContext, getReplyTargetID } from "./Context.js";
import { HANDLER_KEYS } from "./Loader.js";
import { checkAuth } from "../middleware/auth.js";
import { checkAndSetCooldown } from "../middleware/cooldown.js";
import timing from "../timing.js";
import { callFcaApi } from "./fcaApi.js";
import { logger } from "../resilience.js";

function safeErrorSummary(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|authorization|cookie|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 300);
}

// ─── Thread info cache ──────────────────────────────────────────
const threadInfoCache = new Map();
const THREAD_CACHE_TTL = 5 * 60 * 1000;
const MAX_THREAD_CACHE = 1000;

async function getThreadInfoCached(api, threadID) {
  const key = String(threadID);
  const now = Date.now();
  const cached = threadInfoCache.get(key);
  if (cached && cached.expiresAt > now) return cached.data;
  if (cached) threadInfoCache.delete(key);

  try {
    const data = await callFcaApi(api, "getThreadInfo", threadID);
    if (threadInfoCache.size >= MAX_THREAD_CACHE) {
      threadInfoCache.delete(threadInfoCache.keys().next().value);
    }
    threadInfoCache.set(key, { data, expiresAt: now + THREAD_CACHE_TTL });
    return data;
  } catch {
    return null;
  }
}

async function fetchAdminIDsFallback(api, threadID) {
  try {
    const rawApi = api.__rawApi || api;
    if (typeof rawApi.getThreadInfo !== "function") return [];
    const info = await callFcaApi(rawApi, "getThreadInfo", threadID);
    if (Array.isArray(info?.adminIDs) && info.adminIDs.length) return info.adminIDs;
    return Array.isArray(info?.userInfo)
      ? info.userInfo.filter(u => u?.isAdmin || u?.role === "admin" || u?.type === "admin").map(u => u.id).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function invalidateThreadInfoCache(threadID) {
  if (threadID) threadInfoCache.delete(String(threadID));
}

function extractAdminId(entry) {
  if (entry == null) return null;
  if (typeof entry === "object") return entry.id == null ? null : String(entry.id);
  return String(entry);
}

async function resolveGroupAdmin(api, event) {
  if (!event.isGroup) return false;
  const info = await getThreadInfoCached(api, event.threadID);
  let adminIDs = info?.adminIDs;
  if (!Array.isArray(adminIDs) || !adminIDs.length) {
    adminIDs = await fetchAdminIDsFallback(api, event.threadID);
    if (adminIDs.length && info) info.adminIDs = adminIDs;
  }
  const senderID = String(event.senderID);
  return adminIDs?.some(id => extractAdminId(id) === senderID) === true;
}

// تصدير الـ cache ليتمكن الأوامر من استخدامه مباشرةً بدل استدعاء getThreadInfo
export { getThreadInfoCached };
export const handleMessage = async (rawApi, event) => {
  const { threadID, senderID, body, messageReply, messageID } = event;
  const replyTargetID = getReplyTargetID(event);
  const hasAttachment = (event.attachments?.length > 0);
  if (!body?.trim() && !hasAttachment) return;
  const api         = global.wrapApiForSafety(rawApi);
  const messageText = body?.trim() ?? "";
  // Group-only policy: do not read, answer, or otherwise process direct messages.
  if (!event.isGroup) return;
  if (messageReply && global.Kagenou.replies?.[messageReply.messageID]) {
    const replyData = global.Kagenou.replies[messageReply.messageID];
    if (!replyData.author || replyData.author === senderID) {
      delete global.Kagenou.replies[messageReply.messageID];
      const cmdForReply = replyData.commandName ? global.commands.get(replyData.commandName) : null;
      const handler = replyData.onReply || replyData.callback ||
        (cmdForReply?.onReply ? (...a) => cmdForReply.onReply(...a) : null);
      if (typeof handler === "function") {
        const replyMessage = buildMessageAPI(api, threadID, undefined);
        const replyContext = {
          command: replyData.commandName || cmdForReply?.config?.name || "reply-handler",
          commandType: "reply",
          threadID: String(threadID),
          senderID: String(senderID),
        };
        const startedAt = Date.now();
        logger.info("command reply started", replyContext);
        Promise.resolve()
          .then(() => handler({ api, event, message: replyMessage, Reply: replyData }))
          .then(() => logger.info("command reply succeeded", { ...replyContext, durationMs: Date.now() - startedAt }))
          .catch(error => logger.error("command reply failed", {
            ...replyContext,
            durationMs: Date.now() - startedAt,
            errorName: error?.name || "Error",
            error: safeErrorSummary(error),
          }));
      }
    }
    return;
  }
  const prefixes = (global.config?.Prefix || [""]).map(String);
  let resolvedText  = null;
  let matchedPrefix = "";
  for (const pfx of prefixes) {
    if (pfx === "" || messageText.startsWith(pfx)) {
      matchedPrefix = pfx;
      resolvedText  = pfx ? messageText.slice(pfx.length).trim() : messageText;
      break;
    }
  }
  let commandName = null;
  let args        = [];
  let command     = null;
  if (resolvedText !== null) {
    const parts = resolvedText.split(/ +/);
    commandName = parts[0]?.toLowerCase();
    args        = parts.slice(1);
    command     = global.commands.get(commandName);
  }
  if (!command) {
    const rawParts = messageText.split(/ +/);
    const rawName  = rawParts[0]?.toLowerCase();
    const rawCmd   = rawName ? global.commands.get(rawName) : null;
    const allowsNoPrefix = rawCmd?.config?.usePrefix === false || rawCmd?.config?.nonPrefix === true;
    if (rawCmd && allowsNoPrefix) {
      commandName   = rawName;
      args          = rawParts.slice(1);
      command       = rawCmd;
      matchedPrefix = "";
    }
  }
  if (!command) return;
  if (command.config?.enabled === false) {
    api.sendMessage("⚠️ هذا الأمر معطّل مؤقتاً.", threadID, null, replyTargetID);
    return;
  }
  event.command = commandName;
  const _botIndex = rawApi?.__botIndex ?? null;
  const isGroupAdmin = await resolveGroupAdmin(api, event);
  const authError = checkAuth(senderID, command, _botIndex, isGroupAdmin);
  if (authError) return;
  const cooldownError = checkAndSetCooldown(senderID, commandName, command);
  if (cooldownError) { api.sendMessage(cooldownError, threadID, null, replyTargetID); return; }

  const role    = global.getUserRole(senderID, _botIndex);
  const isGroup = !!event.isGroup;
  // فلترة: أوامر مقيّدة بالمجموعات أو الخاص فقط
  if (command.config?.groupOnly === true && !isGroup) {
    api.sendMessage("⚠️ هذا الأمر يعمل داخل المجموعات فقط.", threadID, null, replyTargetID);
    return;
  }
  if (command.config?.dmOnly === true && isGroup) {
    api.sendMessage("⚠️ هذا الأمر يعمل في الرسائل الخاصة فقط.", threadID, null, replyTargetID);
    return;
  }
  const timer = timing.start(`command:${commandName}`);
  const fn = HANDLER_KEYS.map(key => command[key]).find(fn => typeof fn === "function");
  const logContext = {
    command: command.config?.name || commandName,
    alias: commandName,
    threadID: String(threadID),
    senderID: String(senderID),
    botIndex: _botIndex,
  };
  if (!fn) {
    logger.error("command handler missing", logContext);
    timer.end("(بدون معالج)");
    return;
  }
  const startedAt = Date.now();
  logger.info("command started", logContext);
  try {
    const ctx = buildCommandContext({ api, event, args, role, prefix: matchedPrefix, isGroupAdmin });
    await fn(ctx);
    timer.end();
    global.perfManager?.trackRequest(Date.now() - (event.timestamp || Date.now()));
    logger.info("command succeeded", { ...logContext, durationMs: Date.now() - startedAt });
  } catch (err) {
    timer.end("(فشل)");
    global.perfManager?.trackError();
    logger.error("command failed", {
      ...logContext,
      durationMs: Date.now() - startedAt,
      errorName: err?.name || "Error",
      error: safeErrorSummary(err),
    });
    if (!err?.userNotified) {
      try { api.sendMessage("⚠️ حدث خطأ أثناء تنفيذ الأمر.", threadID, null, replyTargetID); } catch (_) {}
    }
  }
};
export const handleReaction = (api, event) => {
  const msgID = event.messageID;
  if (!msgID) return;
  const entry = global.client.reactionListener[msgID];
  if (!entry) return;
  if (entry.author && event.userID !== entry.author) return;
  global._reactionTimestamps.set(msgID, Date.now());
  Promise.resolve()
    .then(() => entry.callback({ api, event }))
    .catch(error => logger.error("reaction callback failed", {
      threadID: String(event.threadID || ""),
      messageID: String(msgID),
      errorName: error?.name || "Error",
      error: safeErrorSummary(error),
    }));
};
export const handleEvent = async (rawApi, event) => {
  if (!event.isGroup) return;
  const api       = global.wrapApiForSafety(rawApi);
  const firstWord = event.body?.trim().split(/ +/)[0]?.toLowerCase();
  // نحسب مرة واحدة هل firstWord يُحيل إلى أيّ أمر (سواء باسمه أو alias)
  const resolvedCmd = firstWord ? global.commands.get(firstWord) : null;
  for (const cmd of global.eventCommands) {
    if (!cmd.onChat) continue;
    const hasAtt = (event.attachments?.length > 0);
    if (!event.messageID || (!event.body && !hasAtt)) continue;
    // تجاهل إذا كانت الرسالة تُطلق هذا الأمر بالذات (اسماً أو alias أو nonPrefix)
    if (resolvedCmd && resolvedCmd === cmd) continue;
    Promise.resolve()
      .then(() => cmd.onChat({ api, event, message: buildMessageAPI(api, event.threadID, event.messageID) }))
      .catch(error => logger.error("event command failed", {
        command: cmd.config?.name || cmd.name || "event-command",
        threadID: String(event.threadID),
        senderID: String(event.senderID),
        errorName: error?.name || "Error",
        error: safeErrorSummary(error),
      }));
  }
};

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-core-router',
  meta: { category: 'core', path: 'utils/core/Router.js' },
  setup(_ctx) {
    // provides: handleEvent, handleMessage, handleReaction
  },
};
