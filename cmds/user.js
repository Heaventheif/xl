
const _config = {
  name: "user",
  version: "2.2.0",
  author: "dev",
  countDown: 5,
  role: 1,
  description: { ar: "إدارة المستخدمين وطلبات الصداقة والمراسلة" },
  category: "admin",
  guide: {
    ar: "{pn} id @شخص\n{pn} name @شخص <اسم>\n{pn} kick @شخص\n{pn} ban @شخص\n{pn} add <UID>\n{pn} req friends   — طلبات الصداقة\n{pn} req messages  — طلبات المراسلة\n\nبعد ظهور القائمة، أرسل رقم الطلب في الرد لقبوله."
  }
};

export default {
  config: _config,
  run: async ({ api, event, args, role, Users, prefix, message }) => {
    const sub = (args[0] || "").toLowerCase();
    if (sub === "req" || sub === "requests") {
      const type = (args[1] || "").toLowerCase();
      if (["friend", "friends", "صداقة"].includes(type)) return showFriendRequests(api, event, message);
      if (["message", "messages", "msg", "مراسلة", "رسائل"].includes(type)) return showMessageRequests(api, event, message);
      return api.sendMessage("الاستخدام:\nuser req friends\nuser req messages", event.threadID, null, event.messageID);
    }
    if (["friendreq", "friendrequests"].includes(sub)) return showFriendRequests(api, event, message);
    if (["msgreq", "messagereq", "messagerequests"].includes(sub)) return showMessageRequests(api, event, message);

    switch (sub) {
      case "id": return handleID(api, event, args.slice(1));
      case "name": return handleName(api, event, args.slice(1));
      case "kick": return handleKick(api, event, args.slice(1));
      case "ban": return handleBan(api, event, Users, role, args.slice(1));
      case "add": return handleAdd(api, event, args.slice(1));
      default: return api.sendMessage(`الاستخدام:\n${_config.guide.ar.replace(/{pn}/g, prefix + "user")}`, event.threadID, null, event.messageID);
    }
  }
};

async function showFriendRequests(api, event, message) {
  const { threadID, messageID } = event;
  if (typeof api.handleFriendRequest !== "function") {
    return api.sendMessage("❌ هذه النسخة من FCA لا توفر API للموافقة على طلبات الصداقة.", threadID, null, messageID);
  }

  try {
    const cached = api.__friendRequests instanceof Map ? [...api.__friendRequests.values()] : [];
    if (!cached.length) {
      return api.sendMessage(
        "ℹ️ لا توجد طلبات صداقة مستلمة منذ تشغيل البوت.\n\nملاحظة: FCA لا يوفر getFriendsList كقائمة لطلبات الصداقة؛ لذلك لن نعرض جميع غير الأصدقاء كطلبات.",
        threadID, null, messageID
      );
    }

    const items = await enrichUsers(api, cached.map(item => ({ id: String(item.id), name: String(item.id) })));
    return sendRequestList(message, api, event, "friend", items);
  } catch (error) {
    console.error("[user friend requests]", error?.message || error);
    return api.sendMessage(`❌ تعذر عرض طلبات الصداقة: ${error?.message || "خطأ غير معروف"}`, threadID, null, messageID);
  }
}

async function showMessageRequests(api, event, message) {
  const { threadID, messageID, senderID } = event;
  if (typeof api.getThreadList !== "function" || typeof api.handleMessageRequest !== "function") {
    return api.sendMessage("❌ هذه النسخة من FCA لا توفر APIs طلبات المراسلة.", threadID, null, messageID);
  }
  try {
    const threads = await api.getThreadList(50, null, ["PENDING"]);
    const requests = (Array.isArray(threads) ? threads : []).filter(thread => {
      const folder = String(thread?.folder || "").toLowerCase();
      return folder === "other" || folder === "pending" || thread?.approvalMode === true;
    });
    if (!requests.length) return api.sendMessage("✅ لا توجد طلبات مراسلة ظاهرة حاليًا.", threadID, null, messageID);
    const rawItems = requests.map(thread => {
      const participant = (thread.participants || []).find(user => String(user.userID) !== String(api.getCurrentUserID?.() || "")) || thread.participants?.[0];
      return { id: thread.threadID, name: thread.name || participant?.name || thread.threadID, threadID: thread.threadID };
    }).filter(item => item.id);
    const items = await enrichUsers(api, rawItems);
    return sendRequestList(message, api, event, "message", items, senderID);
  } catch (error) {
    console.error("[user message requests]", error.message);
    return api.sendMessage(`❌ تعذر جلب طلبات المراسلة: ${error.message || "خطأ غير معروف"}`, threadID, null, messageID);
  }
}

async function enrichUsers(api, items) {
  const ids = [...new Set(items.map(item => item?.id).filter(Boolean).map(String))];
  if (!ids.length || typeof api.getUserInfo !== "function") return items;
  try {
    const info = await api.getUserInfo(ids);
    return items.map(item => {
      const user = info?.[item.id] || info?.[String(item.id)] || {};
      return { ...item, name: user.name || user.fullName || user.displayName || item.name || item.id };
    });
  } catch (_) {
    return items;
  }
}

function formatRequestRows(items) {
  const rows = items.map((item, index) => ({
    no: String(index + 1),
    id: String(item.id || ""),
    name: String(item.name || item.id || "")
  }));
  const noWidth = Math.max(2, String(rows.length).length);
  const idWidth = Math.min(18, Math.max(10, ...rows.map(row => row.id.length)));
  return rows.map(row => {
    const no = row.no.padStart(noWidth, " ");
    const id = row.id.length > idWidth ? `${row.id.slice(0, idWidth - 1)}…` : row.id;
    const name = row.name.replace(/[\r\n]+/g, " ").trim();
    return `${no} │ ${id.padEnd(idWidth, " ")} │ \u2066${name}\u2069`;
  }).join("\n");
}

async function sendRequestList(message, api, event, type, items) {
  const title = type === "friend" ? "🤝 طلبات الصداقة" : "💬 طلبات المراسلة";
  const rows = formatRequestRows(items);
  const text = `${title}\nأرسل رقم الطلب في رد على هذه الرسالة لقبوله.\n\n\`\`\`text\n # │ UID                │ الاسم\n──┼────────────────────┼────────────────────\n${rows}\n\`\`\``;
  const sent = await message.reply(text);
  const replyID = sent?.messageID || sent?.messageId || sent?.id;
  if (!replyID || !message.registerReply) return sent;
  message.registerReply(replyID, { commandName: "user", requestType: type, items, threadID: event.threadID }, ({ api: replyApi, event: replyEvent, Reply }) => handleRequestReply(replyApi, replyEvent, Reply));
  return sent;
}

async function handleRequestReply(api, event, reply) {
  const number = Number(String(event.body || "").trim());
  const items = Array.isArray(reply?.items) ? reply.items : [];
  if (!Number.isInteger(number) || number < 1 || number > items.length) {
    return api.sendMessage(`⚠️ أرسل رقمًا من 1 إلى ${items.length}.`, event.threadID, null, event.messageID);
  }
  const selected = items[number - 1];
  try {
    if (reply.requestType === "friend") {
      await api.handleFriendRequest(String(selected.id), true);
      api.__friendRequests?.delete(String(selected.id));
    } else {
      await api.handleMessageRequest(String(selected.threadID || selected.id), true);
    }
    await api.sendMessage(`✅ تمت الموافقة على ${selected.name} — ${selected.id}`, event.threadID, null, event.messageID);
  } catch (error) {
    await api.sendMessage(`❌ فشلت الموافقة على ${selected.name} — ${selected.id}\n${error.message || "تحقق من API والصلاحيات"}`, event.threadID, null, event.messageID);
  }
}

function targetIDs(event, args = []) {
  const ids = Object.keys(event?.mentions || {});
  const replyID = event?.messageReply?.senderID || event?.messageReply?.author;
  if (replyID && !ids.includes(String(replyID))) ids.push(String(replyID));
  for (const value of args) if (/^\d{6,}$/.test(String(value)) && !ids.includes(String(value))) ids.push(String(value));
  return ids;
}

function mentionName(event, uid) { return String(event?.mentions?.[uid] || "").replace("@", "").trim(); }

const nameCache = new Map();
const NAME_CACHE_MAX = 500;

async function resolvedName(api, event, uid) {
  const mentioned = mentionName(event, uid);
  if (mentioned) return mentioned;
  const key = String(uid);
  const cached = nameCache.get(key);
  if (cached) return cached;
  try {
    const info = await api.getUserInfo(uid);
    const item = info?.[uid] || info?.[String(uid)] || {};
    const name = String(item.name || item.fullName || item.displayName || item.firstName || uid);
    nameCache.delete(key); nameCache.set(key, name);
    if (nameCache.size > NAME_CACHE_MAX) nameCache.delete(nameCache.keys().next().value);
    return name;
  } catch (_) { return uid; }
}

async function handleID(api, event, args = []) {
  const targets = targetIDs(event, args);
  return api.sendMessage(targets.length ? targets.join("\n") : String(event.senderID ?? ""), event.threadID, null, event.messageID);
}

async function handleName(api, event, args) {
  const targets = targetIDs(event, args);
  if (!targets.length) return api.sendMessage("⚠️ قم بمنشن الشخص المراد تغيير لقبه.", event.threadID, null, event.messageID);
  const newName = args.filter(a => !a.startsWith("@") && !/^\d+$/.test(a)).join(" ").trim();
  if (!newName) return api.sendMessage("⚠️ أدخل الاسم الجديد بعد المنشن.", event.threadID, null, event.messageID);
  const results = [];
  for (const uid of targets) {
    try { await api.changeNickname(newName, event.threadID, uid); results.push(`✅ تم تغيير لقب ${await resolvedName(api, event, uid)} — ${uid}`); }
    catch { results.push(`❌ فشل تغيير لقب ${uid}`); }
  }
  return api.sendMessage(results.join("\n"), event.threadID, null, event.messageID);
}

async function handleKick(api, event, args = []) {
  const targets = targetIDs(event, args);
  if (!targets.length) return api.sendMessage("⚠️ قم بمنشن الشخص المراد طرده.", event.threadID, null, event.messageID);
  if (targets.includes(String(event.senderID))) return api.sendMessage("⚠️ لا يمكنك طرد نفسك.", event.threadID, null, event.messageID);
  const results = [];
  for (const uid of targets) {
    try { await api.removeUserFromGroup(uid, event.threadID); results.push(`✅ تم طرد ${await resolvedName(api, event, uid)} — ${uid}`); }
    catch { results.push(`❌ فشل طرد ${uid} — تحقق من صلاحيات البوت`); }
  }
  return api.sendMessage(results.join("\n"), event.threadID, null, event.messageID);
}

async function handleBan(api, event, Users, role, args = []) {
  if (role < 2) return;
  const targets = targetIDs(event, args);
  if (!targets.length) return api.sendMessage("⚠️ قم بمنشن الشخص المراد حظره.", event.threadID, null, event.messageID);
  const results = [];
  for (const uid of targets) {
    try { const data = await Users.getData(uid); if (data?.banned) { results.push(`⚠️ ${uid} محظور بالفعل.`); continue; } await Users.setData(uid, { banned: true }); results.push(`🚫 تم حظر ${await resolvedName(api, event, uid)} — ${uid}`); }
    catch { results.push(`❌ فشل حظر ${uid}`); }
  }
  return api.sendMessage(results.join("\n"), event.threadID, null, event.messageID);
}

async function handleAdd(api, event, args) {
  const targets = targetIDs(event, args);
  if (!targets.length) return api.sendMessage("⚠️ قم بمنشن الشخص أو أدخل UID الشخص المراد إضافته.", event.threadID, null, event.messageID);
  const results = [];
  for (const uid of targets) {
    try { await api.addUserToGroup(uid, event.threadID); results.push(`✅ تمت إضافة ${await resolvedName(api, event, uid)} — ${uid}`); }
    catch (err) { results.push(`❌ فشل إضافة ${uid}: ${err?.error === 1545145 ? "الشخص موجود بالفعل" : err?.error === 200 ? "لا توجد صلاحية كافية" : err?.errorDescription || err?.message || "خطأ غير معروف"}`); }
  }
  return api.sendMessage(results.join("\n"), event.threadID, null, event.messageID);
}

export const $plugin = {
  name: "xx-commands-admin-user",
  meta: { category: "command-admin", path: "cmds/user.js" },
  setup(_ctx) {}
};
