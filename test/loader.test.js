import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCommands } from "../utils/core/Loader.js";

test("command loader swaps the registry without leaving it empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sunken-cmds-"));
  await fs.writeFile(path.join(dir, "hello.js"), "export default { config: { name: 'hello' }, run() {} };\n");
  global.commands = new Map();
  global.eventCommands = [];
  const errors = await loadCommands(dir);
  assert.equal(errors.length, 0);
  assert.equal(global.commands.has("hello"), true);
});
