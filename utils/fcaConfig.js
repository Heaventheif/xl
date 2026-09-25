
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "fca-config.json");

const DEFAULTS = {
  autoLogin: false,
  autoUpdate: false,
  processErrorHandlers: false,
  options: {
    selfListen: false,
    selfListenEvent: false,
    listenEvents: true,
    listenTyping: false,
    updatePresence: false,
    forceLogin: false,
    autoMarkRead: false,
    autoReconnect: true,
    online: true,
    emitReady: false
  },
  session: {
    autoSave: true,
    saveIntervalMs: 10 * 60 * 1000,
    keepAliveIntervalMs: 13 * 60 * 1000,
    healthCheckIntervalMs: 20 * 60 * 1000,
    refreshThresholdMs: 14 * 24 * 60 * 60 * 1000,
    criticalThresholdMs: 3 * 24 * 60 * 60 * 1000
  },
  mqtt: {
    enabled: true,
    autoReconnect: true,
    staleAfterMs: 8 * 60 * 1000,
    watchdogIntervalMs: 30 * 1000,
    pingIntervalMs: 120 * 1000,
    reconnectBaseMs: 2000,
    reconnectCapMs: 5 * 60 * 1000,
    cooldownMs: 15 * 60 * 1000,
    authBlockCooldownMs: 90 * 60 * 1000,
    maxFastAttempts: 10
  }
};

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(base[key] || {}, value)
      : value;
  }
  return out;
}

let cached = null;
export function getFcaConfig() {
  if (cached) return cached;
  let file = {};
  try { file = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (error) { console.warn(`[FCA-CONFIG] تعذر قراءة ${FILE}: ${error.message}`); }
  cached = merge(DEFAULTS, file);
  const envNumber = (name) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const envOverrides = {
    pingIntervalMs: envNumber("MQTT_PING_MS"),
    staleAfterMs: envNumber("MQTT_STALE_MS"),
    watchdogIntervalMs: envNumber("MQTT_WATCHDOG_MS"),
    reconnectBaseMs: envNumber("MQTT_RECONNECT_BASE_MS"),
    reconnectCapMs: envNumber("MQTT_RECONNECT_CAP_MS"),
    cooldownMs: envNumber("MQTT_COOLDOWN_MS"),
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value !== null) cached.mqtt[key] = value;
  }
  return cached;
}

export function getFcaOptions() {
  const config = getFcaConfig();
  return { ...DEFAULTS.options, ...(config.options || {}), autoReconnect: config.mqtt?.autoReconnect !== false && config.options?.autoReconnect !== false };
}

export function getSessionConfig() { return getFcaConfig().session; }
export function getMqttConfig() { return getFcaConfig().mqtt; }
export { FILE as FCA_CONFIG_FILE };
