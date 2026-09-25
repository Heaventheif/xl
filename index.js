process.env.TZ = "Europe/Berlin";
global.__mainErrorHandlersInstalled = true;

import path from "node:path";
import "dotenv/config";
import { checkEnv } from "./utils/envCheck.js";
import { assertAppStatePersistenceSecurity } from "./utils/appStatePersist.js";
import { logger, withRetry, isTransientError } from "./utils/resilience.js";
import { connectDB, disconnectDB, health as dbHealth } from "./db/index.js";
import { loadConfig } from "./utils/config/index.js";
import { loadCommands } from "./utils/core/Loader.js";
import { PROJECT_ROOT, loadAppState, loginBot, stopCleanupInterval } from "./utils/core/Client.js";
import { cleanupOrphanTempFiles } from "./utils/tempCleanup.js";
import "./utils/safeSend.js";
import webServer from "./webserver.js";

const reactionTimestamps = new Map();
const reactionListener = new Proxy({}, {
  set(target, key, value) {
    reactionTimestamps.set(key, Date.now());
    target[key] = value;
    return true;
  },
  deleteProperty(target, key) {
    reactionTimestamps.delete(key);
    delete target[key];
    return true;
  }
});

global.client = { reactionListener };
global._reactionTimestamps = reactionTimestamps;
global.Kagenou = { replies: {} };
global.config = { admins: [], moderators: [], developers: [], vips: [], Prefix: [""], botName: "Sunken Bot" };
for (const name of ["_botAdminIds", "globalData", "usersData", "userCooldowns"]) global[name] = new Map();
for (const name of ["commands", "eventCommands"]) global[name] = name === "commands" ? new Map() : [];
global.appState = {};
global.botApi = null;
global.botApis = [];
global.scheduler = null;
global.perfManager = null;
global.sessionGuard = null;
global.db = null;
global.dbHealth = dbHealth;

global.log = {
  info: (message, context) => logger.info(message, context),
  warn: (message, context) => logger.warn(message, context),
  error: (message, context) => logger.error(message, context),
  success: (message, context) => logger.info(message, { status: "success", ...context })
};

checkEnv(PROJECT_ROOT);
assertAppStatePersistenceSecurity();
loadConfig(PROJECT_ROOT);
const commandsDir = path.join(PROJECT_ROOT, "cmds");
global.reloadCommands = () => loadCommands(commandsDir);

async function start() {
  cleanupOrphanTempFiles();
  await connectDB();
  await loadCommands(commandsDir);
  const appState = await loadAppState();
  if (!appState) throw new Error("AppState غير موجود أو غير صالح؛ سجّل الدخول باستخدام AppState فقط");
  const loginTask = () => loginBot(appState);
  await withRetry(loginTask, {
    label: "facebook-login",
    retries: 5,
    baseMs: 2000,
    capMs: 60000,
    shouldRetry: isTransientError
  });
  logger.info("البوت متصل وجاهز");
}

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { stopCleanupInterval(); } catch (_) {}
  try { await global.botApi?.__stopSessionLifecycle?.(); } catch (_) {}
  for (const api of global.botApis || []) {
    try { await api?.__stopSessionLifecycle?.(); } catch (_) {}
    try { api?._scheduler?.destroy?.(); } catch (_) {}
    try { api?.__sessionLock?.release?.(); } catch (_) {}
  }
  await new Promise(resolve => webServer?.close?.(() => resolve()) || resolve());
  try { await disconnectDB(); } catch (_) {}
  process.exit(0);
});

start().catch(error => logger.error("startup failure", { error: error?.stack || error?.message || String(error) }));
