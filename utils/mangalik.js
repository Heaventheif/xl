import { load } from "cheerio";

export const MANGALIK_ORIGIN = "https://mangalik.net";
const MANGA_PATH_PREFIX = "/manga/";

function isMangalikHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "mangalik.net" || host.endsWith(".mangalik.net");
}

export function normalizeMangalikUrl(value, base = MANGALIK_ORIGIN) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || !isMangalikHost(url.hostname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function buildSearchUrl(title) {
  const url = new URL("/", MANGALIK_ORIGIN);
  url.searchParams.set("s", String(title || "").trim());
  url.searchParams.set("post_type", "wp-manga");
  return url.href;
}

export function buildSearchTerms(title) {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  const variants = [raw];
  const crossVariant = raw.replace(/\s+[x×]\s+/gi, " × ");
  const compactCrossVariant = crossVariant.replace(/\s*×\s*/g, "×");
  const asciiVariant = raw.replace(/×/g, "x");
  if (crossVariant) variants.push(crossVariant);
  if (compactCrossVariant) variants.push(compactCrossVariant);
  if (asciiVariant) variants.push(asciiVariant);
  return [...new Set(variants)].filter(Boolean).slice(0, 4);
}

export function normalizeMangaTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/×/g, "x")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function similarity(a, b) {
  const left = normalizeMangaTitle(a);
  const right = normalizeMangaTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = value => {
    const result = [];
    for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
    return result;
  };
  const aPairs = bigrams(left);
  const bPairs = bigrams(right);
  if (!aPairs.length || !bPairs.length) return left.includes(right) || right.includes(left) ? 0.5 : 0;
  const counts = new Map();
  for (const pair of bPairs) counts.set(pair, (counts.get(pair) || 0) + 1);
  let matches = 0;
  for (const pair of aPairs) {
    const count = counts.get(pair) || 0;
    if (count > 0) {
      matches++;
      counts.set(pair, count - 1);
    }
  }
  return (2 * matches) / (aPairs.length + bPairs.length);
}

export function parseMangaSearchResults(html) {
  const $ = load(String(html || ""));
  const results = new Map();

  $("a[href*='/manga/']").each((_, element) => {
    const anchor = $(element);
    const mangaUrl = normalizeMangalikUrl(anchor.attr("href"));
    if (!mangaUrl) return;
    const segments = mangaUrl.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== "manga") return;

    const container = anchor.closest(".c-tabs-item");
    const title = container.find(".post-title a").first().text().trim()
      || anchor.attr("title")
      || anchor.find("img").attr("alt")
      || anchor.text().trim()
      || decodeURIComponent(segments[1]).replace(/[-_]+/g, " ");
    const canonicalUrl = `${MANGALIK_ORIGIN}${MANGA_PATH_PREFIX}${segments[1]}/`;
    if (!results.has(canonicalUrl)) results.set(canonicalUrl, { title, url: canonicalUrl });
  });

  return [...results.values()];
}

export function pickBestManga(title, candidates, minimumScore = 0.22) {
  let best = null;
  let bestScore = 0;
  const normalizedQuery = normalizeMangaTitle(title);
  for (const candidate of candidates || []) {
    const slug = new URL(candidate.url).pathname.split("/").filter(Boolean).at(-1) || "";
    const score = Math.max(similarity(title, candidate.title), similarity(normalizedQuery, slug));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= minimumScore ? { manga: best, score: bestScore } : { manga: null, score: bestScore };
}

export function normalizeChapterNumber(value) {
  const raw = String(value || "").trim().replace(/,/g, ".");
  const fractional = raw.match(/^(\d+)[._-](\d+)$/);
  if (fractional) return `${fractional[1]}.${fractional[2]}`;
  return raw;
}

export function isValidChapterNumber(value) {
  return /^(?:\d+)(?:[._-]\d+)?$/.test(String(value || "").trim());
}

export function toChapterSlug(value) {
  const raw = String(value || "").trim();
  if (!isValidChapterNumber(raw)) return null;
  return raw.replace(/\.(?=\d+$)/, "-");
}

export function buildChapterUrl(mangaUrl, chapter) {
  const safeMangaUrl = normalizeMangalikUrl(mangaUrl);
  const chapterSlug = toChapterSlug(chapter);
  if (!safeMangaUrl || !chapterSlug) return null;
  const segments = safeMangaUrl.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "manga") return null;
  return `${MANGALIK_ORIGIN}${MANGA_PATH_PREFIX}${segments[1]}/${encodeURIComponent(chapterSlug)}/`;
}

export function findChapterRedirect(mangaHtml, mangaUrl, chapter) {
  const target = normalizeChapterNumber(chapter);
  const $ = load(String(mangaHtml || ""));
  let resolved = null;
  $("select.single-chapter-select option[data-redirect]").each((_, element) => {
    if (resolved) return;
    const option = $(element);
    const redirect = normalizeMangalikUrl(option.attr("data-redirect"), mangaUrl);
    if (!redirect) return;
    const redirectChapter = decodeURIComponent(redirect.pathname.split("/").filter(Boolean).at(-1) || "");
    const values = [option.text().trim(), option.attr("value"), redirectChapter];
    if (values.some(value => normalizeChapterNumber(value) === target)) resolved = redirect.href;
  });
  return resolved;
}

export function extractChapterImages(html, chapterUrl) {
  const $ = load(String(html || ""));
  const images = [];
  const seen = new Set();
  $(".reading-content img.wp-manga-chapter-img, .reading-content .page-break img").each((_, element) => {
    const image = $(element);
    const source = image.attr("data-src")
      || image.attr("data-lazy-src")
      || image.attr("data-original")
      || image.attr("src");
    const url = normalizeMangalikUrl(source, chapterUrl);
    if (!url || url.protocol !== "https:" || /^data:/i.test(source || "")) return;
    if (seen.has(url.href)) return;
    seen.add(url.href);
    images.push(url.href);
  });
  return images;
}

export function getFirecrawlHtml(response) {
  const html = response?.data?.html ?? response?.html;
  return typeof html === "string" ? html : "";
}
