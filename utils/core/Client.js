import fs   from "fs-extra";
import path from "path";
import { createRequire }  from "node:module";
import { fileURLToPath }  from "node:url";

// ── استيراد fca-nx (CJS) ─────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const fcaPackage = require("fca-nx");
const login = typeof fcaPackage === "function" ? fcaPackage : (fcaPackage.login ?? fcaPackage.default);

import { readAppStateFromEnv, updateAppStateInMemory } from "../runtimeEnv.js";
import { resolveAppState, persistAppState } from "../appStatePersist.js";
import { getFcaOptions } from "../fcaConfig.js";
import { dispatchMqttEvent }    from "../events/onMessage.js";
import { startCleanupInterval, stopCleanupInterval } from "../events/onReady.js";
import { createMqttConnectionManager } from "./MqttConnectionManager.js";
import { initBotLifecycle }    from "./bot-init.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(MODULE_DIR, "..", "..");

// ── اسم البوت ─────────────────────────────────────────────────────────────────
const BOT_NAMES_FILE = path.join(PROJECT_ROOT, "botNames.json");

function loadBotNames() {
  try {
    if (fs.existsSync(BOT_NAMES_FILE))
      return JSON.parse(fs.readFileSync(BOT_NAMES_FILE, "utf8")) || {};
  } catch (_) {}
  return {};
}

function saveBotName(botIndex, name) {
  if (!name) return;
  try {
    const all = loadBotNames();
    all[String(botIndex)] = name;
    const tmp = BOT_NAMES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    fs.renameSync(tmp, BOT_NAMES_FILE);
  } catch (_) {}
}

export function getBotName(botIndex) {
  return loadBotNames()[String(botIndex)] || null;
}

// ── AppState ──────────────────────────────────────────────────────────────────
export async function loadAppState() {
  const state = readAppStateFromEnv();
  const resolved = await resolveAppState(state, 1);
  if (!resolved.state) return null;
  return { state: resolved.state, index: 1, source: resolved.source || "APPSTATE" };
}

export async function loadAllAppStates() {
  const account = await loadAppState();
  return account ? [account] : [];
}

export function saveAppStateForBot(state, botIndex = 1, source = "runtime") {
  try {
    if (!Array.isArray(state) || state.length === 0) throw new Error("فارغ");
    const keys = new Set(state.map(c => String(c?.key ?? c?.name ?? "")));
    if (!keys.has("c_user") || !keys.has("xs")) throw new Error("cookies ناقصة");
    updateAppStateInMemory(state);
    persistAppState(state, source);
    console.log(`[APPSTATE] ✅ (${state.length} cookie | Bot-${botIndex} | ${source})`);
    return true;
  } catch (err) {
    console.warn(`[APPSTATE] ⚠️ ${err.message}`);
    return false;
  }
}

// ── خيارات fca-nx ─────────────────────────────────────────────────────────────
const GLOBAL_OPTIONS = getFcaOptions();

async function initializeBot(api, index, label, replacedApi = null) {
  if (replacedApi && replacedApi !== api) {
    try { await replacedApi.__stopSessionLifecycle?.(); } catch (_) {}
    global.botApis = (global.botApis || []).filter(item => item !== replacedApi && item?.__botIndex !== index);
    if (global.botApi === replacedApi) global.botApi = null;
  }

  await initBotLifecycle(api, index, {
    saveAppState:    saveAppStateForBot,
    onMqttEvent:     (event, _api) => dispatchMqttEvent(_api, event, label),
    onFirstBotReady: () => startCleanupInterval(),
    getBotName, saveBotName, createMqttConnectionManager,
    // لا يوجد onAuthFailed — AppState فقط، لا استرداد بالبريد
  });
}

// ── تسجيل الدخول بـ AppState فقط ─────────────────────────────────────────────
export function loginBot(account) {
  const { state, index } = account;
  const label = `Bot-${index}`;
  console.log(`[LOGIN:${label}] 🔑 تسجيل الدخول بـ AppState...`);

  return new Promise((resolve, reject) => {
    login({ appState: state }, GLOBAL_OPTIONS, async (err, api) => {
      if (err) {
        const msg = err?.error || err?.message || String(err);
        console.error(`[LOGIN:${label}] ❌ AppState فشل: ${msg}`);
        return reject(new Error(msg));
      }
      console.log(`[LOGIN:${label}] ✅ AppState نجح`);
      try { await initializeBot(api, index, label); resolve(api); }
      catch (e) { reject(e); }
    });
  });
}

export const loginBotWithAppState = loginBot;
export { loadBotNames, stopCleanupInterval };
