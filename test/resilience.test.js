import test from "node:test";
import assert from "node:assert/strict";
import { MqttConnectionManager } from "../utils/core/MqttConnectionManager.js";
import { preserveDeviceFingerprint } from "../utils/appStatePersist.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("MQTT manager drains buffered events in arrival order", async () => {
  let callback;
  const received = [];
  const api = {
    listenMqtt(cb) {
      callback = cb;
      return { stopListening: async () => {} };
    },
  };
  const manager = new MqttConnectionManager(api, {
    staleAfterMs: 10_000,
    watchdogIntervalMs: 60_000,
    pingIntervalMs: 60_000,
    onEvent: async (event) => {
      received.push(event.id);
      if (event.id === 1) await wait(15);
    },
  });

  manager.start();
  await wait(5);
  callback(null, { id: 1, type: "message" });
  callback(null, { id: 2, type: "message" });
  await wait(40);
  await manager.stop();

  assert.deepEqual(received, [1, 2]);
  assert.equal(manager.eventsDropped, 0);
});

test("AppState persistence preserves the existing datr fingerprint", () => {
  const previous = [{ key: "datr", value: "stable-device" }];
  const next = [{ key: "datr", value: "new-device" }, { key: "c_user", value: "1" }];
  assert.equal(preserveDeviceFingerprint(previous, next)[0].value, "stable-device");
});
