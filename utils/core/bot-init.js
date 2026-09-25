import { createRequire } from "node:module";
import { getMqttConfig, getSessionConfig } from "../fcaConfig.js";
const _require = createRequire(import.meta.url);

// ── تحميل attachThreadInfoRealtimeSync من fca-nx ─────────────────────────────
let _attachThreadInfoRealtimeSync = null;
try {
  const fcaNx = _require("fca-nx");
  _attachThreadInfoRealtimeSync =
    fcaNx.attachThreadInfoRealtimeSync ??
    fcaNx.default?.attachThreadInfoRealtimeSync ??
    null;
  if (_attachThreadInfoRealtimeSync)
    console.log("[BOT-INIT] ✅ attachThreadInfoRealtimeSync محمَّل من fca-nx");
} catch (e) {
  console.warn("[BOT-INIT] ⚠️ تعذَّر تحميل attachThreadInfoRealtimeSync:", e.message);
}

// ── botEnhancer (اختياري) ─────────────────────────────────────────────────────
let _botEnhancerFn = null;
try {
  const mod = await import("../bot-enhancer.js").catch(() => null);
  _botEnhancerFn = mod?.default ?? null;
} catch (_) {}

// ── SessionExtender (اختياري) ─────────────────────────────────────────────────
let _createSessionExtender = null;
try {
  const mod = await import("../safety/session-extender.js").catch(() => null);
  _createSessionExtender = mod?.createSessionExtender ?? null;
} catch (_) {}

// ────────────────────────────────────────────────────────────────────────────
// startMqttListener
// ────────────────────────────────────────────────────────────────────────────
export async function startMqttListener(api, opts = {}) {
  const { label, botIndex, onEvent, createMqttConnectionManager, onAuthFailed } = opts;
  if (getMqttConfig().enabled === false) {
    console.warn(`[MQTT:${label}] معطّل من fca-config.json`);
    return null;
  }
  if (api.__mqttManager) return api.__mqttManager.reconnect("duplicate_start");
  if (typeof createMqttConnectionManager !== "function") {
    console.error(`[MQTT:${label}] ❌ createMqttConnectionManager غير مُمرَّر`);
    return null;
  }

  const manager = createMqttConnectionManager(api, {
    label, botIndex,
    ...getMqttConfig(),
    onState: (health) => {
      api.__mqttHealth = health;
      global._mqttHealthByBot = global._mqttHealthByBot || new Map();
      global._mqttHealthByBot.set(botIndex, health);
    },
    onEvent: (event) => {
      if (global._pausedBots?.has(botIndex)) return;
      try { onEvent?.(event, api); }
      catch (err) { console.error(`[EVENT:${label}]`, err.message); }
    },
    onAuthFailed,
  });

  api.__mqttManager    = manager;
  api.__forceReconnect = (r = "manual") => manager.reconnect(r);
  api.__stopWatchdog   = () => manager.stop();
  api.__mqttHealth     = manager.health();

  manager.on("ping_ok",     () => {});
  manager.on("auth_failed", (h) =>
    console.error(`[MQTT:${label}] 🔒 AppState محجوب:`, h.lastError || "auth_failed"));
  manager.on("cooldown", (h) =>
    console.warn(`[MQTT:${label}] ⏳ cooldown حتى ${h.cooldownUntil}`));

  manager.start();
  console.log(`[SUCCESS] ${label} مدير MQTT نشط (fca-nx)`);
  return manager;
}

// ────────────────────────────────────────────────────────────────────────────
// initBotLifecycle
// ────────────────────────────────────────────────────────────────────────────
export async function initBotLifecycle(api, botIndex, opts = {}) {
  const {
    saveAppState             = () => {},
    onMqttEvent              = () => {},
    onFirstBotReady          = () => {},
    getBotName               = () => null,
    saveBotName              = () => {},
    createMqttConnectionManager,
    onAuthFailed,
  } = opts;

  const label      = `Bot-${botIndex}`;
  const isFirstBot = botIndex === 1;
  const sessionCfg = getSessionConfig();

  // ── إيقاف دورة الحياة ────────────────────────────────────────────────────
  api.__lifecycleStopped     = false;
  api.__stopSessionLifecycle = async () => {
    if (api.__lifecycleStopped) return;
    api.__lifecycleStopped = true;
    clearTimeout(api.__appStateSaveTimer);
    api.__appStateSaveTimer = null;
    for (const timer of api.__markReadTimers || []) clearTimeout(timer);
    api.__markReadTimers?.clear?.();
    try { api._sessionExtender?.stop(); } catch (_) {}
    try { await api.__mqttManager?.stop(); } catch (_) {}
  };

  // ── خيارات MQTT ──────────────────────────────────────────────────────────
  try {
    api.setOptions({
      forceLogin: true, listenEvents: true, updatePresence: false,
      selfListen: false, online: true, autoMarkRead: false, listenTyping: false,
    });
  } catch (_) {}

  console.log(`[LOGIN:${label}] ✅ الاتصال بفيسبوك مستقر (fca-nx)`);

  // ── تسجيل global ─────────────────────────────────────────────────────────
  global.botApis = (global.botApis || []).filter(item => item !== api && item?.__botIndex !== botIndex);
  global.botApis.push(api);
  api.__botIndex = botIndex;
  if (isFirstBot) global.botApi = api;
  api.__botName = getBotName(botIndex);

  // ── جلب اسم الحساب ───────────────────────────────────────────────────────
  ;(async () => {
    try {
      const uid = api.getCurrentUserID?.();
      if (!uid) return;
      api.__botFbId = String(uid);
      const info = await new Promise((res, rej) =>
        api.getUserInfo(uid, (err, r) => err ? rej(err) : res(r)));
      const name = info?.[uid]?.name;
      if (name) {
        api.__botName = name;
        saveBotName(botIndex, name);
        console.log(`[NAME:${label}] 🏷️ ${name} (${uid})`);
      }
    } catch (e) { console.warn(`[NAME:${label}] ⚠️`, e.message); }
  })();

  // ── Thread-info realtime sync (من fca-nx) ────────────────────────────────
  if (typeof _attachThreadInfoRealtimeSync === "function") {
    try {
      _attachThreadInfoRealtimeSync(api);
      console.log(`[SYNC:${label}] ✅ Thread-info realtime sync نشط (fca-nx)`);
    } catch (e) { console.warn(`[SYNC:${label}] ⚠️`, e.message); }
  }

  // ── botEnhancer ───────────────────────────────────────────────────────────
  try { _botEnhancerFn?.(); } catch (_) {}

  // ── SessionExtender ───────────────────────────────────────────────────────
  if (typeof _createSessionExtender === "function") {
    try {
      const extender = _createSessionExtender({
        api, botIndex,
        checkIntervalMs:    sessionCfg.healthCheckIntervalMs,
        keepAliveIntervalMs:sessionCfg.keepAliveIntervalMs,
        refreshThresholdMs: sessionCfg.refreshThresholdMs,
        criticalThresholdMs:sessionCfg.criticalThresholdMs,
        onAppStateSave: (s) => saveAppState(s, botIndex, "keep-alive"),
        onExtended: ({ count }) => {
          try {
            const s = api.getAppState?.();
            if (s?.length) saveAppState(s, botIndex, "extended");
          } catch (_) {}
          console.log(`[EXTENDER:${label}] 📦 تمديد #${count}`);
        },
      });
      extender.start();
      api._sessionExtender = extender;
      console.log(`[EXTENDER:${label}] ✅ SessionExtender نشط`);
    } catch (e) { console.warn(`[EXTENDER:${label}] ⚠️`, e.message); }
  }

  // ── حفظ AppState الأولي ───────────────────────────────────────────────────
  const freshState = api.getAppState?.();
  if (freshState?.length) {
    saveAppState(freshState, botIndex, "post-login");
    if (isFirstBot) global.appState = freshState;
  }

  // ── حفظ دوري (60–120 دقيقة) ──────────────────────────────────────────────
  ;(function scheduleAppStateSave() {
    const baseMs  = sessionCfg.saveIntervalMs || 600_000;
    const delay   = baseMs + Math.random() * baseMs;
    api.__appStateSaveTimer = setTimeout(() => {
      try {
        const s = api.getAppState?.();
        if (s?.length) { saveAppState(s, botIndex, "scheduled"); if (isFirstBot) global.appState = s; }
      } catch (_) {}
      if (!api.__lifecycleStopped) scheduleAppStateSave();
    }, delay);
    api.__appStateSaveTimer.unref?.();
  })();

  // ── MQTT ──────────────────────────────────────────────────────────────────
  await startMqttListener(api, {
    label, botIndex, createMqttConnectionManager, onAuthFailed,
    onEvent: onMqttEvent,
  });

  if (isFirstBot) onFirstBotReady();
}
