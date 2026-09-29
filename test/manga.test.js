import test from "node:test";
import assert from "node:assert/strict";
import mangaCommand, { mangaScraperTestHelpers } from "../cmds/manga.js";

const {
  MAX_PER_GROUP,
  MAX_CHAPTER_PAGES,
  MAX_IMAGE_BYTES,
  buildChapterCandidates,
  isExactChapterMatch,
  isReadableChapter,
  pickBestChapterResult,
  buildPageUrlsFromAtHome,
} = mangaScraperTestHelpers;

test("manga command is registered and sends no more than 14 images in a message group", () => {
  assert.equal(mangaCommand.config.name, "manga");
  assert.equal(MAX_PER_GROUP, 14);
  assert.equal(MAX_CHAPTER_PAGES, 300);
  assert.equal(MAX_IMAGE_BYTES, 16 * 1024 * 1024);
});

test("MangaDex chapter matching is exact and excludes unreadable/external chapters", () => {
  assert.deepEqual(buildChapterCandidates("1"), ["1", "1.0"]);
  assert.equal(isExactChapterMatch("1", 1), true);
  assert.equal(isExactChapterMatch("10", 1), false);
  assert.equal(isExactChapterMatch(null, 1), false);
  assert.equal(isReadableChapter({ pages: 2 }), true);
  assert.equal(isReadableChapter({ pages: 0 }), false);
  assert.equal(isReadableChapter({ pages: 3, externalUrl: "https://example.org/" }), false);

  const selected = pickBestChapterResult([
    { id: "wrong-prefix", attributes: { chapter: "10", pages: 20, translatedLanguage: "ar" } },
    { id: "external", attributes: { chapter: "1", pages: 20, translatedLanguage: "ar", externalUrl: "https://example.org/" } },
    { id: "exact-readable", attributes: { chapter: "1.0", pages: 20, translatedLanguage: "ar", readableAt: "2025-01-01T00:00:00Z" } },
  ], 1);
  assert.deepEqual(selected, { id: "exact-readable", lang: "ar" });
});

test("MangaDex page URLs honor the server-provided base path and reject unsafe inputs", () => {
  const urls = buildPageUrlsFromAtHome({
    baseUrl: "https://cdn.example.net/node/abc/",
    chapter: { hash: "0123abcd", data: ["1-page.jpg", "2 page.png", "../escape.jpg", "nested/page.jpg"] },
  });
  assert.deepEqual(urls, [
    "https://cdn.example.net/node/abc/data/0123abcd/1-page.jpg",
    "https://cdn.example.net/node/abc/data/0123abcd/2%20page.png",
  ]);
  assert.deepEqual(buildPageUrlsFromAtHome({ baseUrl: "http://cdn.example.net", chapter: { hash: "abc", data: ["1.jpg"] } }), []);
  assert.deepEqual(buildPageUrlsFromAtHome({ baseUrl: "https://user:pass@cdn.example.net", chapter: { hash: "abc", data: ["1.jpg"] } }), []);
  assert.deepEqual(buildPageUrlsFromAtHome({ baseUrl: "https://cdn.example.net", chapter: { hash: "../bad", data: ["1.jpg"] } }), []);
});
