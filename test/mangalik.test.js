import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChapterUrl,
  buildSearchTerms,
  buildSearchUrl,
  extractChapterImages,
  findChapterRedirect,
  parseMangaSearchResults,
  pickBestManga,
} from "../utils/mangalik.js";
import mangalikCommand from "../cmds/mangalik.js";

const searchHtml = `
  <div class="c-tabs-item">
    <div class="tab-thumb"><a href="https://mangalik.net/manga/spyxfamily/" title="SPY×FAMILY"><img alt="SPY×FAMILY"></a></div>
    <div class="tab-summary"><div class="post-title"><h3><a href="https://mangalik.net/manga/spyxfamily/">SPY×FAMILY</a></h3></div></div>
  </div>
  <a href="https://mangalik.net/manga/spyxfamily/138/">chapter link must be ignored</a>
  <a href="https://example.org/manga/other/">foreign link must be ignored</a>
`;

test("exports the new Mangalik command with its aliases and 14-image packet policy", () => {
  assert.equal(mangalikCommand.config.name, "mangalik");
  assert.ok(mangalikCommand.config.aliases.includes("mangalek"));
  assert.match(mangalikCommand.config.description, /14/);
});

test("parses first-party manga search results and excludes chapter/foreign URLs", () => {
  const results = parseMangaSearchResults(searchHtml);
  assert.deepEqual(results, [{ title: "SPY×FAMILY", url: "https://mangalik.net/manga/spyxfamily/" }]);
  assert.equal(pickBestManga("Spy x Family", results).manga.url, "https://mangalik.net/manga/spyxfamily/");
});

test("builds search terms that cover the site’s x versus multiplication-sign spelling", () => {
  assert.deepEqual(buildSearchTerms("Spy x Family"), ["Spy x Family", "Spy × Family", "Spy×Family"]);
  assert.equal(new URL(buildSearchUrl("Spy×Family")).searchParams.get("post_type"), "wp-manga");
  assert.equal(new URL(buildSearchUrl("Spy×Family")).searchParams.get("s"), "Spy×Family");
});

test("constructs integer and fractional chapter URLs and uses the exact detail-page redirect", () => {
  const mangaUrl = "https://mangalik.net/manga/spyxfamily/";
  assert.equal(buildChapterUrl(mangaUrl, "138"), "https://mangalik.net/manga/spyxfamily/138/");
  assert.equal(buildChapterUrl(mangaUrl, "139.2"), "https://mangalik.net/manga/spyxfamily/139-2/");

  const detailHtml = `<select class="single-chapter-select">
    <option value="139-2" data-redirect="https://mangalik.net/manga/spyxfamily/139-2/">139.2</option>
    <option value="77_1" data-redirect="https://mangalik.net/manga/spyxfamily/77_1/">77.1</option>
  </select>`;
  assert.equal(findChapterRedirect(detailHtml, mangaUrl, "139.2"), "https://mangalik.net/manga/spyxfamily/139-2/");
  assert.equal(findChapterRedirect(detailHtml, mangaUrl, "77.1"), "https://mangalik.net/manga/spyxfamily/77_1/");
});

test("extracts only Mangalik reader images in page order and keeps required query strings", () => {
  const chapterHtml = `<img src="https://io.mangalik.net/logo.png">
    <div class="reading-content">
      <div class="page-break"><img id="image-0" class="wp-manga-chapter-img" src="https://leksolo.mangalik.net/page-01.jpg?sig=one"></div>
      <div class="page-break"><img id="image-1" class="wp-manga-chapter-img" data-src="https://leksolo.mangalik.net/page-02.webp"></div>
    </div>`;
  assert.deepEqual(extractChapterImages(chapterHtml, "https://mangalik.net/manga/spyxfamily/138/"), [
    "https://leksolo.mangalik.net/page-01.jpg?sig=one",
    "https://leksolo.mangalik.net/page-02.webp",
  ]);
});
