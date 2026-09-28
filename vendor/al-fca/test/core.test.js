"use strict";
const test = require("node:test");
const assert = require("node:assert");
const humanize = require("../src/core/humanize");
const { compareVersions } = require("../checkUpdate");

test("compareVersions orders semver", () => {
    assert.strictEqual(compareVersions("2.1.0", "2.0.3"), 1);
    assert.strictEqual(compareVersions("2.0.3", "2.0.3"), 0);
    assert.strictEqual(compareVersions("1.9.9", "2.0.0"), -1);
});

test("humanize is opt-in and merges defaults", () => {
    assert.strictEqual(humanize.resolve({}).enabled, false);
    assert.strictEqual(humanize.resolve({ humanize: false }).enabled, false);
    assert.strictEqual(humanize.resolve({ humanize: true }).enabled, true);
    const r = humanize.resolve({ humanize: { minGapMs: 5 } });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.minGapMs, 5);
});

test("typing duration scales with length and stays in bounds", () => {
    const cfg = Object.assign({}, humanize.DEFAULTS, { jitter: 0 });
    assert.strictEqual(humanize.typingDuration(cfg, ""), cfg.typingMinMs);
    assert.strictEqual(humanize.typingDuration(cfg, "x".repeat(10000)), cfg.typingMaxMs);
    assert.ok(humanize.typingDuration(cfg, "x".repeat(40)) > cfg.typingMinMs);
});

test("pacer keeps per-thread order and minimum gap", async () => {
    const ctx = { globalOptions: { humanize: { minGapMs: 60, jitter: 0, enabled: true } } };
    const run = humanize.createPacer(ctx);
    const order = [], stamps = [];
    const mk = (n) => run("t1", async () => { order.push(n); stamps.push(Date.now()); });
    await Promise.all([mk(1), mk(2), mk(3)]);
    assert.deepStrictEqual(order, [1, 2, 3]);
    assert.ok(stamps[1] - stamps[0] >= 55 && stamps[2] - stamps[1] >= 55);
});

test("pacer passes through when disabled", async () => {
    const run = humanize.createPacer({ globalOptions: { humanize: false } });
    const t = Date.now();
    await Promise.all([run("a", async () => 1), run("a", async () => 2)]);
    assert.ok(Date.now() - t < 50);
});
