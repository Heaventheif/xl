import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import { Readable } from "node:stream";
import http from "../utils/fetchHttp.js";
import { downloadAudio } from "../utils/ytEngine.js";

test("Yozora audio fallback skips a redundant metadata request", async () => {
  const originalGet = http.get;
  const calls = [];
  let downloaded;
  http.get = async (url) => {
    calls.push(String(url));
    return { data: Readable.from([Buffer.from("audio bytes")]) };
  };
  try {
    downloaded = await downloadAudio("https://youtu.be/abcdefghijk");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/download/);
    assert.equal(downloaded.title, "audio");
    assert.ok((await fs.stat(downloaded.filePath)).size > 0);
  } finally {
    http.get = originalGet;
    if (downloaded?.filePath) await fs.remove(downloaded.filePath);
  }
});
