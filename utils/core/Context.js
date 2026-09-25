
function buildMessageAPI(api, threadID, messageID) {
  return {
    reply: (t, cb) => new Promise((resolve, reject) => {
      global.safeSend(api, t, threadID, (err, info) => {
        if (cb) cb(err, info);
        if (err) reject(err);
        else resolve(info || {});
      }, messageID);
    }),
    unsend: (msgID, tid) => {
      try { api.unsendMessage(msgID, tid || threadID, () => {}); } catch (_) {}
    },
    registerReply: (id, d, cb, senderID) => {
      global.Kagenou.replies[id] = {
        callback: cb,
        author: senderID,
        timestamp: Date.now(),
        ...d,
      };
    },
  };
}

// إذا كان الأمر مكتوباً كردّ على رسالة، فالنتيجة يجب أن تشير إلى الرسالة
// المُشار إليها. نحتفظ بمعرّف رسالة الأمر الأصلي في commandMessageID.
function getReplyTargetID(event) {
  return event?.messageReply?.messageID || event?.messageID;
}

// واجهة موحَّدة لبيانات المستخدمين تعمل مع:
//   • global.usersData  (Map في الذاكرة — دائماً موجودة)
//   • BanModel / global._bannedUsers  (MongoDB — إن كان متصلاً)
// تتوافق مع: Users.getData(uid) / Users.setData(uid, obj)
function buildUsersInterface() {
  return {
    /**
     * جلب بيانات مستخدم — يُعيد الكائن أو {} إذا لم يوجد
     */
    getData: async (uid) => {
      const key = String(uid);
      if (typeof global.getUserData === "function") {
        try { return await global.getUserData(key); } catch (_) {}
      }
      return global.usersData?.get(key) ?? {};
    },

    /**
     * تحديث بيانات مستخدم — يدمج مع القيم الموجودة
     * يدعم حقل banned بشكل خاص: يحدِّث global._bannedUsers + BanModel
     */
    setData: async (uid, data) => {
      const key = String(uid);

      const existing = global.usersData?.get(key) ?? {};
      const merged   = { ...existing, ...data };
      global.usersData?.set(key, { ...merged, _dirty: true });

      if ("banned" in data) {
        if (data.banned) {
          global._bannedUsers?.add(key);
        } else {
          global._bannedUsers?.delete(key);
        }
        if (global.db) {
          try {
            const { addBanDB, removeBanDB } = await import("../../db/index.js");
            if (data.banned) {
              await addBanDB("user", key, data.bannedBy ?? null, data.banReason ?? null);
            } else {
              await removeBanDB("user", key);
            }
          } catch (e) {
            console.warn("[Users.setData] فشل تحديث BanModel:", e.message);
          }
        }
      }
    },
  };
}

// واجهة موحَّدة لبيانات المجموعات تعمل مع:
//   • global.threadsData  (Map في الذاكرة — إن وُجدت)
//   • BanModel / global._bannedGroups  (MongoDB — إن كان متصلاً)
// تتوافق مع: Threads.getData(tid) / Threads.setData(tid, obj)
function buildThreadsInterface() {
  return {
    /**
     * جلب بيانات مجموعة — يُعيد الكائن أو {} إذا لم توجد
     */
    getData: async (tid) => {
      const key = String(tid);
      if (global.threadsData?.has?.(key)) return global.threadsData.get(key);
      const banned = global._bannedGroups?.has(key) ?? false;
      return { banned };
    },

    /**
     * تحديث بيانات مجموعة — يدمج مع القيم الموجودة
     * يدعم حقل banned بشكل خاص: يحدِّث global._bannedGroups + BanModel
     */
    setData: async (tid, data) => {
      const key = String(tid);

      if (global.threadsData) {
        const existing = global.threadsData.get(key) ?? {};
        global.threadsData.set(key, { ...existing, ...data });
      }

      if ("banned" in data) {
        if (data.banned) {
          global._bannedGroups?.add(key);
        } else {
          global._bannedGroups?.delete(key);
        }
        if (global.db) {
          try {
            const { addBanDB, removeBanDB } = await import("../../db/index.js");
            if (data.banned) {
              await addBanDB("group", key, data.bannedBy ?? null, data.banReason ?? null);
            } else {
              await removeBanDB("group", key);
            }
          } catch (e) {
            console.warn("[Threads.setData] فشل تحديث BanModel:", e.message);
          }
        }
      }
    },
  };
}

function buildCommandContext({ api, event, args = [], role = 0, prefix = "", isGroupAdmin = false }) {
  const { threadID } = event;
  const messageID = getReplyTargetID(event);
  const commandEvent = messageID && messageID !== event.messageID
    ? { ...event, commandMessageID: event.messageID, messageID }
    : event;
  const isGroup = !!commandEvent.isGroup;
  return {
    api,
    event: commandEvent,
    args,
    role,
    isGroup,
    isDM: !isGroup,
    isGroupAdmin,
    message: buildMessageAPI(api, threadID, messageID),
    prefix,
    usersData:  global.usersData,
    globalData: global.globalData,
    db:         global.db,
    Users: buildUsersInterface(),
    Threads: buildThreadsInterface()
  };
}

export { buildMessageAPI, buildCommandContext, getReplyTargetID };

/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-core-context',
  meta: { category: 'core', path: 'utils/core/Context.js' },
  setup(_ctx) {
    // provides: buildCommandContext, buildMessageAPI
  },
};
