import test from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../utils/core/Router.js";

const GLOBAL_KEYS = [
  "wrapApiForSafety", "config", "Kagenou", "commands", "getUserRole",
  "checkCooldown", "setCooldown", "perfManager",
];

function saveGlobals() {
  return Object.fromEntries(GLOBAL_KEYS.map(key => [key, Object.hasOwn(global, key) ? global[key] : undefined]));
}

function restoreGlobals(previous) {
  for (const key of GLOBAL_KEYS) {
    if (previous[key] === undefined) delete global[key];
    else global[key] = previous[key];
  }
}

function parseLogMessages(lines) {
  return lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function setupRouterGlobals(command, threadID) {
  global.wrapApiForSafety = api => api;
  global.config = { Prefix: ["!"] };
  global.Kagenou = { replies: {} };
  global.commands = new Map([["probe", command]]);
  global.getUserRole = () => 0;
  global.checkCooldown = () => null;
  global.setCooldown = () => {};
  global.perfManager = { trackRequest() {}, trackError() {} };

  const sent = [];
  const api = {
    getThreadInfo(_threadID, callback) { callback(null, { adminIDs: ["user-1"] }); },
    sendMessage(...args) { sent.push(args); },
  };
  const event = {
    body: "!probe",
    threadID,
    senderID: "user-1",
    messageID: `message-${threadID}`,
    isGroup: true,
    timestamp: Date.now(),
  };
  return { api, event, sent };
}

function captureConsole() {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const method of Object.keys(originals)) {
    console[method] = (...args) => lines.push(args.map(String).join(" "));
  }
  return { lines, restore: () => Object.assign(console, originals) };
}

test("logs command start and success with command/thread/user identifiers", async () => {
  const previous = saveGlobals();
  const capture = captureConsole();
  try {
    const { api, event } = setupRouterGlobals({ config: { name: "probe", role: 0 }, onStart: async () => {} }, "logging-success-thread");
    await handleMessage(api, event);
    const messages = parseLogMessages(capture.lines).filter(item => item.command === "probe");
    assert.deepEqual(messages.map(item => item.message), ["command started", "command succeeded"]);
    assert.equal(messages[0].threadID, "logging-success-thread");
    assert.equal(messages[0].senderID, "user-1");
  } finally {
    capture.restore();
    restoreGlobals(previous);
  }
});

test("logs command failures and emits a generic user message only when not already notified", async () => {
  const previous = saveGlobals();
  const capture = captureConsole();
  try {
    const commandError = new Error("upstream unavailable");
    const { api, event, sent } = setupRouterGlobals({
      config: { name: "probe", role: 0 },
      onStart: async () => { throw commandError; },
    }, "logging-failure-thread");
    await handleMessage(api, event);
    const messages = parseLogMessages(capture.lines).filter(item => item.command === "probe");
    assert.deepEqual(messages.map(item => item.message), ["command started", "command failed"]);
    assert.equal(messages[1].error, "upstream unavailable");
    assert.equal(sent.length, 1);

    global.Kagenou = { replies: {} };
    global.commands = new Map([["probe", {
      config: { name: "probe", role: 0 },
      onStart: async () => { throw Object.assign(new Error("already sent"), { userNotified: true }); },
    }]]);
    const notified = setupRouterGlobals(global.commands.get("probe"), "logging-notified-thread");
    await handleMessage(notified.api, notified.event);
    assert.equal(notified.sent.length, 0);
  } finally {
    capture.restore();
    restoreGlobals(previous);
  }
});

test("logs reply-handler failures instead of dropping them silently", async () => {
  const previous = saveGlobals();
  const capture = captureConsole();
  try {
    global.wrapApiForSafety = api => api;
    global.config = { Prefix: ["!"] };
    global.Kagenou = { replies: {
      "reply-source": { author: "user-1", commandName: "probe", callback: async () => { throw new Error("reply failed"); } },
    } };
    global.commands = new Map();
    const api = { sendMessage() {} };
    await handleMessage(api, {
      body: "reply text",
      threadID: "logging-reply-thread",
      senderID: "user-1",
      messageID: "reply-message",
      messageReply: { messageID: "reply-source" },
      isGroup: true,
    });
    await new Promise(resolve => setImmediate(resolve));
    const messages = parseLogMessages(capture.lines).filter(item => item.message?.startsWith("command reply"));
    assert.deepEqual(messages.map(item => item.message), ["command reply started", "command reply failed"]);
    assert.equal(messages[1].error, "reply failed");
  } finally {
    capture.restore();
    restoreGlobals(previous);
  }
});
