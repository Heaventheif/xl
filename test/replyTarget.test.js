import test from "node:test";
import assert from "node:assert/strict";
import { buildCommandContext, getReplyTargetID } from "../utils/core/Context.js";

function captureSafeSend(t) {
  const previous = global.safeSend;
  const calls = [];
  global.safeSend = (api, body, threadID, callback, messageID) => {
    calls.push({ api, body, threadID, messageID });
    callback?.(null, { messageID: "bot-response" });
    return Promise.resolve({ messageID: "bot-response" });
  };
  t.after(() => {
    if (previous === undefined) delete global.safeSend;
    else global.safeSend = previous;
  });
  return calls;
}

test("a command sent as a reply targets the original user's message", async t => {
  const calls = captureSafeSend(t);
  const api = {};
  const event = {
    threadID: "group-1",
    senderID: "user-1",
    messageID: "command-message",
    messageReply: { messageID: "user-2-message", senderID: "user-2" },
  };

  assert.equal(getReplyTargetID(event), "user-2-message");
  const context = buildCommandContext({ api, event, args: ["status"] });
  assert.equal(context.event.messageID, "user-2-message");
  assert.equal(context.event.commandMessageID, "command-message");

  await context.message.reply("bot response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "bot response");
  assert.equal(calls[0].threadID, "group-1");
  assert.equal(calls[0].messageID, "user-2-message");
});

test("a command without a replied-to message targets its own message", async t => {
  const calls = captureSafeSend(t);
  const context = buildCommandContext({
    api: {},
    event: { threadID: "group-1", senderID: "user-1", messageID: "command-message" },
  });

  assert.equal(context.event.messageID, "command-message");
  await context.message.reply("bot response");
  assert.equal(calls[0].messageID, "command-message");
});
