import test from "node:test";
import assert from "node:assert/strict";
import { SessionExtender } from "../utils/safety/session-extender.js";

test("a zero keep-alive interval disables pings and their timer", async () => {
  let appStateReads = 0;
  const extender = new SessionExtender({
    api: { getAppState() { appStateReads += 1; return []; } },
    keepAliveIntervalMs: 0,
  });

  assert.equal(extender.getStats().keepAliveEnabled, false);
  await extender.pingNow();
  assert.equal(appStateReads, 0);

  extender.start();
  assert.equal(extender._keepAliveTimer, null);
  extender.stop();
});
