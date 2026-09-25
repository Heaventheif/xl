import test from "node:test";
import assert from "node:assert/strict";
import { checkAppStateExpiry } from "../utils/appStatePersist.js";

test("AppState expiry ignores session cookies without expiry", () => {
  const state = [{ key: "c_user", value: "1", expires: "Infinity" }, { key: "xs", value: "x", expires: "Infinity" }];
  const info = checkAppStateExpiry(state);
  assert.equal(info.critical, false);
  assert.equal(info.minTtlMs, Infinity);
});

test("AppState expiry detects critical c_user expiry", () => {
  const state = [{ key: "c_user", value: "1", expires: Date.now() + 60_000 }, { key: "xs", value: "x", expires: Date.now() + 60_000 }];
  const info = checkAppStateExpiry(state);
  assert.equal(info.critical, true);
  assert.ok(info.criticalCookies.includes("c_user"));
});
