import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import novelCommand, { novelScraperTestHelpers } from "../cmds/novel.js";

const { parseChapterInput, findNovelFullChapterUrl, novelFullIndexPages, buildNovelFullIndexUrl, isChallengeHTML, supportedFallbackSites } = novelScraperTestHelpers;

test("novel command is registered and includes NovelFull as a fallback source", () => {
  assert.equal(novelCommand.config.name, "novel");
  assert.ok(supportedFallbackSites.includes("NovelFull"));
  assert.deepEqual(novelScraperTestHelpers.bridgeSites, ["Freewebnovel", "NovelFull"]);
});

test("chapter input preserves valid fractional chapter numbers and rejects invalid input", () => {
  assert.equal(parseChapterInput("12"), 12);
  assert.equal(parseChapterInput("1.5"), 1.5);
  assert.equal(parseChapterInput("0"), null);
  assert.equal(parseChapterInput("1.5x"), null);
  assert.equal(parseChapterInput("1/2"), null);
  assert.equal(parseChapterInput("100001"), null);
});

test("NovelFull index lookup targets the requested chapter's likely page and nearby pages", () => {
  assert.deepEqual(novelFullIndexPages(1.1), [1, 2, 3]);
  assert.deepEqual(novelFullIndexPages(254), [6, 7, 5, 8, 4, 1]);
  assert.deepEqual(novelFullIndexPages(100001), []);
  const url = new URL(buildNovelFullIndexUrl("https://novelfull.com/book.html", 6));
  assert.equal(url.searchParams.get("page"), "6");
  assert.equal(url.searchParams.get("per-page"), "50");
  assert.equal([...url.searchParams.keys()].filter(key => key === "page").length, 1);
});

test("NovelFull chapter links match the visible exact chapter label, not a numeric URL prefix", () => {
  const $ = cheerio.load(`
    <a href="/novel/chapter-11-reader.html" title="Chapter 1.1 - Reader">Chapter 1.1</a>
    <a href="/novel/chapter-12-reader.html" title="Chapter 1.2 - Reader">Chapter 1.2</a>
    <a href="/novel/chapter-1-main.html" title="Chapter 1 - Main">Chapter 1</a>
    <a href="https://example.org/chapter-1-evil.html" title="Chapter 1">Chapter 1</a>
  `);
  assert.equal(findNovelFullChapterUrl($, 1.1), "https://novelfull.com/novel/chapter-11-reader.html");
  assert.equal(findNovelFullChapterUrl($, 1.2), "https://novelfull.com/novel/chapter-12-reader.html");
  assert.equal(findNovelFullChapterUrl($, 1), "https://novelfull.com/novel/chapter-1-main.html");
  assert.equal(findNovelFullChapterUrl($, 99), null);
});

test("challenge detection does not reject ordinary pages that merely mention Cloudflare", () => {
  assert.equal(isChallengeHTML("<script src='https://cdnjs.cloudflare.com/'>reader</script>"), false);
  assert.equal(isChallengeHTML("<title>Just a moment...</title>"), true);
  assert.equal(isChallengeHTML("cf-chl-widget challenge-platform"), true);
});
