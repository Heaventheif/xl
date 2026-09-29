import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireVendored = createRequire(path.join(projectRoot, "vendor/al-fca/index.js"));
const fca = requireVendored(path.join(projectRoot, "vendor/al-fca"));
const request = requireVendored("request");

test("vendored al-fca skips helper modules while building API factories", () => {
  const jar = request.jar();
  jar.setCookie("c_user=123456789; Domain=.facebook.com; Path=/", "https://www.facebook.com");

  const built = fca.buildAPI({}, "<html></html>", jar);

  assert.equal(typeof built.api.listenMqtt, "function");
  assert.equal(typeof built.api.getUserInfo, "function");
  assert.equal(typeof built.api.sendMessage, "function");
});
