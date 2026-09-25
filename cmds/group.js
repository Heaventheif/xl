
const _config = {
    name: "group",
    version: "2.2.0",
    author: "dev",
    countDown: 5,
    role: 1,
    description: {
        ar: "إدارة المجموعة عبر APIs FCA: معلومات، إحصائيات، موافقة الأعضاء، حظر، تغيير الاسم، إدارة المشرفين"
    },
    category: "admin",
    guide: {
        ar: "{pn} info               — معلومات المجموعة (GID + الأعضاء)\n" + "{pn} id                 — عرض GID فقط\n" + "{pn} stats              — إحصائيات المجموعة\n" + "{pn} approval            — حالة موافقة الأعضاء\n" + "{pn} ban                — حظر المجموعة من البوت (مطور فقط)\n" + "{pn} rename <الاسم>     — تغيير اسم المجموعة\n" + "{pn} admin add @شخص    — إضافة مشرف\n" + "{pn} admin remove @شخص — إزالة مشرف"
    }
};

export default {
    config: _config,
    run: async function({api: api, event: event, args: args, role: role, Threads: Threads, Users: Users, prefix: prefix}) {
        const {threadID: threadID, messageID: messageID} = event;
        const sub = (args[0] || "").toLowerCase();
        switch (sub) {
          case "info":
            return handleInfo(api, event);

          case "id":
            return api.sendMessage(String(threadID), threadID, null, messageID);

          case "stats":
            return handleStats(api, event);

          case "approval":
            return handleApproval(api, event);

          case "ban":
            return handleBan(api, event, Threads, role);

          case "rename":
            return handleRename(api, event, args.slice(1).join(" "));

          case "admin":
            return handleAdmin(api, event, args.slice(1));

          default:
            return api.sendMessage(`❓ الاستخدام:\n${_config.guide.ar.replace(/{pn}/g, prefix + "group")}`, threadID, null, messageID);
        }
    }
};

async function handleInfo(api, event) {
    const {threadID: threadID, messageID: messageID} = event;
    let info;
    try {
        info = await api.getThreadInfo(threadID);
    } catch {
        return api.sendMessage("❌ فشل جلب معلومات المجموعة.", threadID, null, messageID);
    }
    const participantIDs = Array.isArray(info.participantIDs) ? info.participantIDs.map(String) : [];
    let userInfo = {};
    try {
        userInfo = await api.getUserInfo(participantIDs);
    } catch (_) {}
    const memberList = participantIDs.slice(0, 30).map(((id, i) => {
        const item = userInfo?.[id] || {};
        const name = item.name || item.fullName || item.displayName || item.firstName || id;
        return `  ${i + 1}. ${name} — ${id}`;
    })).join("\n");
    const msg = `📋 ─── معلومات المجموعة ───\n` + `🆔 GID : ${threadID}\n` + `📝 الاسم : ${info.threadName || "—"}\n` + `👥 الأعضاء : ${participantIDs.length}\n` + `🛡️ المشرفون : ${info.adminIDs?.length ?? 0}\n\n` + `👤 قائمة الأعضاء (أول 30):\n${memberList}` + (participantIDs.length > 30 ? `\n  … و ${participantIDs.length - 30} آخرين` : "");
    return api.sendMessage(msg, threadID, null, messageID);
}

async function handleStats(api, event) {
    const {threadID: threadID, messageID: messageID} = event;
    let info;
    try {
        info = await api.getThreadInfo(threadID);
    } catch {
        return api.sendMessage("❌ فشل جلب إحصائيات المجموعة.", threadID, null, messageID);
    }
    const participantIDs = Array.isArray(info.participantIDs) ? info.participantIDs : [];
    const approvalMode = info.approvalMode ? "مفعّل ✅" : "معطّل ❌";
    const msgCount = info.messageCount ?? "—";
    const msg = `📊 ─── إحصائيات المجموعة ───\n` + `🆔 GID       : ${threadID}\n` + `📝 الاسم     : ${info.threadName || "—"}\n` + `👥 الأعضاء   : ${participantIDs.length}\n` + `💬 الرسائل   : ${msgCount}\n` + `🔒 موافقة    : ${approvalMode}\n` + `📅 آخر نشاط  : ${new Date(info.timestamp).toLocaleString("ar-EG")}`;
    return api.sendMessage(msg, threadID, null, messageID);
}

async function handleApproval(api, event) {
    const { threadID, messageID } = event;
    try {
        const info = await api.getThreadInfo(threadID);
        const enabled = Boolean(info?.approvalMode);
        return api.sendMessage(`🔐 موافقة الأعضاء في هذه المجموعة: ${enabled ? "مفعّلة ✅" : "معطّلة ❌"}\n🆔 ${threadID}`, threadID, null, messageID);
    } catch (error) {
        return api.sendMessage(`❌ تعذر جلب حالة الموافقة: ${error.message || "خطأ غير معروف"}`, threadID, null, messageID);
    }
}

async function handleBan(api, event, Threads, role) {
    const {threadID: threadID, messageID: messageID} = event;
    if (role < 2) return;
    try {
        const data = await Threads.getData(threadID);
        if (data.banned) return api.sendMessage("⚠️ المجموعة محظورة بالفعل.", threadID, null, messageID);
        await Threads.setData(threadID, {
            banned: true
        });
        return api.sendMessage(`🚫 تم حظر المجموعة بنجاح.\nGID: ${threadID}`, threadID, null, messageID);
    } catch {
        return api.sendMessage("❌ فشل حظر المجموعة.", threadID, null, messageID);
    }
}

async function handleRename(api, event, newName) {
    const {threadID: threadID, messageID: messageID} = event;
    if (!newName.trim()) return api.sendMessage("⚠️ أدخل الاسم الجديد للمجموعة.", threadID, null, messageID);
    try {
        await api.setTitle(newName.trim(), threadID);
        api.sendMessage(`✅ تم تغيير اسم المجموعة إلى:\n"${newName.trim()}"`, threadID, null, messageID);
    } catch {
        api.sendMessage("❌ فشل تغيير اسم المجموعة.", threadID, null, messageID);
    }
}

async function handleAdmin(api, event, args) {
    const {threadID: threadID, messageID: messageID, mentions: mentions} = event;
    const action = (args[0] || "").toLowerCase();
    if (![ "add", "remove" ].includes(action)) return api.sendMessage("⚠️ الاستخدام:\ngroup admin add @شخص\ngroup admin remove @شخص", threadID, null, messageID);
    const targets = [ ...Object.keys(mentions || {}) ];
    const replyID = event?.messageReply?.senderID || event?.messageReply?.author;
    if (replyID && !targets.includes(String(replyID))) targets.push(String(replyID));
    for (const value of args.slice(1)) {
        if (/^\d{6,}$/.test(String(value)) && !targets.includes(String(value))) targets.push(String(value));
    }
    if (!targets.length) return api.sendMessage("⚠️ قم بمنشن الشخص أو رد على رسالته أو أدخل UID الشخص.", threadID, null, messageID);
    let info = {};
    if (typeof api.getUserInfo === "function") {
        try { info = await api.getUserInfo(targets); } catch (_) {}
    }
    const results = [];
    for (const uid of targets) {
        try {
            await api.changeAdminStatus(threadID, uid, action === "add");
            const item = info?.[uid] || {};
            const name = item.name || item.fullName || item.displayName || mentions[uid]?.replace("@", "") || uid;
            results.push(`✅ ${action === "add" ? "تمت إضافة" : "تمت إزالة"} ${name} — ${uid}`);
        } catch (error) {
            results.push(`❌ فشل ${action === "add" ? "إضافة" : "إزالة"} ${uid}${error?.message ? `: ${error.message}` : ""}`);
        }
    }
    return api.sendMessage(results.join("\n"), threadID, null, messageID);
}

export const $plugin = {
    name: "xx-commands-admin-group",
    meta: {
        category: "command-admin",
        path: "cmds/group.js"
    },
    setup(_ctx) {}
};
