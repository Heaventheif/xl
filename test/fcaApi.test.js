import test from "node:test";
import assert from "node:assert/strict";
import { callFcaApi, getFcaClient, hasFcaMethod } from "../utils/core/fcaApi.js";
import { getFcaOptions } from "../utils/fcaConfig.js";
import { MqttConnectionManager } from "../utils/core/MqttConnectionManager.js";

test("maps the namespaced thread-info call to al-fca and resolves callback data", async () => {
  const api = {
    getThreadInfo(threadID, callback) {
      callback(null, { threadID, participantIDs: ["12"] });
    },
  };

  assert.equal(hasFcaMethod(api, "threads.getInfo"), true);
  assert.deepEqual(await callFcaApi(api, "threads.getInfo", "42"), {
    threadID: "42",
    participantIDs: ["12"],
  });
});

test("adapts setAdmin arguments and accepts APIs that return a Promise", async () => {
  let actualArgs;
  const api = {
    changeAdminStatus(threadID, userID, enabled, callback) {
      actualArgs = [threadID, userID, enabled];
      callback(null, "ok");
      return Promise.resolve("ok");
    },
  };

  assert.equal(await callFcaApi(api, "threads.setAdmin", 42, 77, true), "ok");
  assert.deepEqual(actualArgs, ["42", "77", true]);
});

test("rejects callback errors and reports unavailable methods", async () => {
  const api = {
    getUserInfo(_userID, callback) {
      callback(new Error("Facebook request failed"));
    },
  };

  await assert.rejects(callFcaApi(api, "users.getInfo", "77"), /Facebook request failed/);
  assert.equal(hasFcaMethod(api, "threads.setTitle"), false);
  await assert.rejects(callFcaApi(api, "threads.setTitle", "title", "42"), /al-fca API is unavailable/);
});

test("supports a raw API wrapped by __rawApi", async () => {
  const rawApi = {
    handleFriendRequest(userID, accept, callback) {
      callback(null, { userID, accept });
    },
  };

  assert.deepEqual(await callFcaApi({ __rawApi: rawApi }, "account.handleFriendRequest", "77", true), {
    userID: "77",
    accept: true,
  });
});

test("preserves the old namespaced client shape for downstream modules", async () => {
  const api = {
    getThreadInfo(threadID, callback) { callback(null, { threadID }); },
  };
  const client = getFcaClient(api);
  assert.deepEqual(await client.threads.getInfo("42"), { threadID: "42" });
  assert.equal(getFcaClient(api), client);
});

test("leaves MQTT reconnection to the bot's single watchdog", () => {
  assert.equal(getFcaOptions().autoReconnect, false);
});

test("does not report a known-disconnected MQTT socket as healthy from stale activity", () => {
  const previous = global.mqttClient;
  try {
    global.mqttClient = { connected: false };
    const manager = new MqttConnectionManager({}, { staleAfterMs: 60_000 });
    manager.stopped = false;
    manager.state = "CONNECTED";
    manager.lastEventAt = Date.now();
    assert.equal(manager._socketAlive(), false);
    assert.equal(manager.health().transportAlive, false);
    assert.equal(manager.health().ok, false);
  } finally {
    if (previous === undefined) delete global.mqttClient;
    else global.mqttClient = previous;
  }
});

test("logs the trigger and socket state when MQTT reconnection is requested", async () => {
  const manager = new MqttConnectionManager({ _mqttClient: { connected: false } });
  const originalWarn = console.warn;
  let logMessage = "";
  console.warn = (message) => { logMessage = String(message); };
  manager.stopped = false;

  try {
    const reconnect = manager.reconnect("ping_failed");
    assert.match(logMessage, /reason=ping_failed/);
    assert.match(logMessage, /socketConnected=false/);
    await manager.stop();
    await reconnect;
  } finally {
    console.warn = originalWarn;
  }
});

test("a hung al-fca listener stop times out and force-closes its socket", async () => {
  const previous = global.mqttClient;
  let forcedClosed = false;
  try {
    global.mqttClient = {
      connected: false,
      end(force) { forcedClosed = force === true; },
    };
    const manager = new MqttConnectionManager({}, { stopTimeoutMs: 5 });
    manager.listener = { stopListeningAsync: () => new Promise(() => {}) };
    await manager._stopListener();
    assert.equal(forcedClosed, true);
    assert.equal(manager.listener, null);
    assert.equal(global.mqttClient, null);
  } finally {
    if (previous === undefined) delete global.mqttClient;
    else global.mqttClient = previous;
  }
});
