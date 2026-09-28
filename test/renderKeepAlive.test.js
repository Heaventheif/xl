import test from "node:test";
import assert from "node:assert/strict";
import { createRenderKeepAlive, RENDER_KEEP_ALIVE_INTERVAL_MS } from "../utils/core/renderKeepAlive.js";

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    active() { return scheduled.filter(timer => !timer.cleared); },
  };
}

const quietLogger = { info() {}, warn() {} };

test("Render keep-alive is disabled outside Render", () => {
  const timers = fakeTimers();
  const pinger = createRenderKeepAlive({
    enabled: false,
    baseUrl: "https://example.onrender.com",
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logger: quietLogger,
  });

  pinger.start();
  assert.equal(pinger.url, null);
  assert.equal(timers.active().length, 0);
});

test("pings the Render health endpoint and schedules the next ping in 13 minutes", async () => {
  const timers = fakeTimers();
  const calls = [];
  const pinger = createRenderKeepAlive({
    enabled: true,
    baseUrl: "https://xl-mw6v.onrender.com/old-path?token=ignored",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logger: quietLogger,
  });

  pinger.start();
  assert.equal(timers.active()[0].delay, 5_000);
  assert.equal(await pinger.pingNow(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://xl-mw6v.onrender.com/health");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, RENDER_KEEP_ALIVE_INTERVAL_MS);

  pinger.stop();
  assert.equal(timers.active().length, 0);
});

test("retries a failed health ping after one minute", async () => {
  const timers = fakeTimers();
  const pinger = createRenderKeepAlive({
    enabled: true,
    baseUrl: "https://xl-mw6v.onrender.com",
    fetchImpl: async () => ({ ok: false, status: 503 }),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    logger: quietLogger,
  });

  pinger.start();
  assert.equal(await pinger.pingNow(), false);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 60_000);
  pinger.stop();
});
