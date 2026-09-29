import test from "node:test";
import assert from "node:assert/strict";
import { downloadWithFallback, providers, searchWithFallback } from "../utils/ytProviders.js";

function saveProviderMethods() {
  return providers.map(provider => ({
    provider,
    search: provider.search,
    download: provider.download,
  }));
}

function restoreProviderMethods(saved) {
  for (const item of saved) {
    if (item.search === undefined) delete item.provider.search;
    else item.provider.search = item.search;
    if (item.download === undefined) delete item.provider.download;
    else item.provider.download = item.download;
  }
}

test("Vreden is the primary YouTube search provider", async () => {
  assert.equal(providers[0].name, "vreden-youtube-scraper");
  const saved = saveProviderMethods();
  const calls = [];
  try {
    providers[0].search = async (query, limit) => {
      calls.push([query, limit]);
      return [{ url: "https://youtube.com/watch?v=example", title: "Example" }];
    };
    for (const provider of providers.slice(1)) {
      provider.search = async () => { throw new Error("fallback should not be called"); };
    }
    const results = await searchWithFallback("example query", 5);
    assert.equal(results[0].title, "Example");
    assert.deepEqual(calls, [["example query", 5]]);
  } finally {
    restoreProviderMethods(saved);
  }
});

test("downloads try Vreden first, normalize the YouTube URL, then fall back sequentially", async () => {
  const saved = saveProviderMethods();
  const calls = [];
  try {
    providers[0].download = async (url, wantMp4) => {
      calls.push(["vreden", url, wantMp4]);
      throw new Error("temporary Vreden failure");
    };
    providers[1].download = async (url, wantMp4) => {
      calls.push(["engine", url, wantMp4]);
      return { filePath: "/tmp/example.mp4", title: "Example" };
    };
    for (const provider of providers.slice(2)) {
      provider.download = async () => { throw new Error("later fallback should not be called"); };
    }

    const result = await downloadWithFallback("https://youtu.be/example", true);
    assert.equal(result.provider, "yozora-engine");
    assert.equal(result.filePath, "/tmp/example.mp4");
    assert.deepEqual(calls, [
      ["vreden", "https://www.youtube.com/watch?v=example", true],
      ["engine", "https://www.youtube.com/watch?v=example", true],
    ]);
  } finally {
    restoreProviderMethods(saved);
  }
});

test("identical searches are coalesced and cached without sharing mutable result objects", async () => {
  const saved = saveProviderMethods();
  const query = `cache-regression-${Date.now()}`;
  const calls = [];
  try {
    providers[0].search = async (_query, limit) => {
      calls.push(limit);
      await new Promise(resolve => setTimeout(resolve, 20));
      return [{ url: "https://www.youtube.com/watch?v=cachetest", title: "Original", limit }];
    };
    for (const provider of providers.slice(1)) {
      provider.search = async () => { throw new Error("fallback should not be called"); };
    }

    const [first, concurrent] = await Promise.all([
      searchWithFallback(query, 1),
      searchWithFallback(query, 1),
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(first, concurrent);

    first[0].title = "mutated";
    const cached = await searchWithFallback(query, 1);
    assert.equal(calls.length, 1);
    assert.equal(cached[0].title, "Original");
  } finally {
    restoreProviderMethods(saved);
  }
});
