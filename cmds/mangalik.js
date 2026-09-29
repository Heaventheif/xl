import axios from "axios";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { downloadWithLimit } from "../utils/concurrentDownload.js";
import { FirecrawlClientError, firecrawlClient } from "../utils/firecrawlClient.js";
import {
  buildChapterUrl,
  buildSearchTerms,
  buildSearchUrl,
  extractChapterImages,
  findChapterRedirect,
  getFirecrawlHtml,
  normalizeMangalikUrl,
  parseMangaSearchResults,
  pickBestManga,
} from "../utils/mangalik.js";
import { logger } from "../utils/resilience.js";

const MAX_IMAGES_PER_MESSAGE = 14;
const MAX_IMAGES_PER_CHAPTER = 140;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const REDIRECT_LIMIT = 3;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

class MangalikCommandError extends Error {
  constructor(code, message = code, extra = {}) {
    super(message);
    this.name = "MangalikCommandError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function getSafeErrorMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|authorization|cookie|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 240);
}

function makeReportedError() {
  const error = new Error("Mangalik command failed after notifying the user.");
  error.name = "UserNotifiedCommandError";
  error.userNotified = true;
  return error;
}

function send(api, body, threadID, replyToID = null) {
  return new Promise((resolve, reject) => {
    try {
      global.safeSend(api, body, threadID, (error, info) => error ? reject(error) : resolve(info), replyToID);
    } catch (error) {
      reject(error);
    }
  });
}

function getPayloadData(response) {
  return response?.data && typeof response.data === "object" ? response.data : response;
}

function assertScrapePage(response, pageLabel) {
  const data = getPayloadData(response);
  const statusCode = Number(data?.metadata?.statusCode ?? data?.statusCode ?? response?.metadata?.statusCode);
  if (statusCode >= 400) {
    throw new MangalikCommandError("MANGALIK_PAGE_NOT_FOUND", `${pageLabel} returned HTTP ${statusCode}.`, { statusCode });
  }
  const html = getFirecrawlHtml(response);
  if (!html) throw new MangalikCommandError("MANGALIK_EMPTY_HTML", `${pageLabel} returned no HTML.`);
  return html;
}

async function scrapeHtml(url) {
  return firecrawlClient.scrape(url, { timeout: REQUEST_TIMEOUT_MS });
}

async function searchManga(title) {
  for (const term of buildSearchTerms(title)) {
    const response = await scrapeHtml(buildSearchUrl(term));
    const html = assertScrapePage(response, "Mangalik search");
    const candidates = parseMangaSearchResults(html);
    const best = pickBestManga(title, candidates);
    if (best.manga) return best.manga;
  }
  return null;
}

async function getChapterPage(manga, chapter) {
  const directUrl = buildChapterUrl(manga.url, chapter);
  if (!directUrl) throw new MangalikCommandError("INVALID_CHAPTER", "Invalid chapter number.");

  let detailHtml = null;
  const readDetailPage = async () => {
    if (detailHtml !== null) return detailHtml;
    const detailResponse = await scrapeHtml(manga.url);
    detailHtml = assertScrapePage(detailResponse, "Mangalik manga page");
    return detailHtml;
  };

  // Resolve fractional chapters first because some Mangalik URLs use underscores
  // and the detail page supplies the exact redirect URL.
  let exactUrl = null;
  if (/[._-]/.test(chapter)) {
    exactUrl = findChapterRedirect(await readDetailPage(), manga.url, chapter);
  }

  const candidates = [...new Set([exactUrl, directUrl].filter(Boolean))];
  for (const chapterUrl of candidates) {
    let chapterHtml;
    try {
      chapterHtml = assertScrapePage(await scrapeHtml(chapterUrl), "Mangalik chapter");
    } catch (error) {
      if (error?.code === "MANGALIK_PAGE_NOT_FOUND") continue;
      throw error;
    }
    const imageUrls = extractChapterImages(chapterHtml, chapterUrl);
    if (imageUrls.length) return { chapterUrl, imageUrls };
  }

  // Retry through the site's selector for integer chapters if the direct URL was
  // not found or did not contain reader pages.
  const detail = await readDetailPage();
  exactUrl = findChapterRedirect(detail, manga.url, chapter);
  if (exactUrl && !candidates.includes(exactUrl)) {
    const exactResponse = await scrapeHtml(exactUrl);
    const exactHtml = assertScrapePage(exactResponse, "Mangalik chapter");
    const imageUrls = extractChapterImages(exactHtml, exactUrl);
    if (imageUrls.length) return { chapterUrl: exactUrl, imageUrls };
  }

  throw new MangalikCommandError("NO_CHAPTER_IMAGES", "No reader images were found for this chapter.");
}

function validateImageResponse(response) {
  const contentType = String(response.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  const extension = MIME_EXTENSIONS.get(contentType);
  if (!extension) {
    response.data?.destroy?.();
    throw new Error("The image response had an unsupported content type.");
  }
  const declaredSize = Number(response.headers?.["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
    response.data?.destroy?.();
    throw new Error("The image exceeded the download size limit.");
  }
  return extension;
}

async function downloadImage(imageUrl, destination, referer) {
  let currentUrl = imageUrl;
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const response = await axios.get(currentUrl, {
      responseType: "stream",
      timeout: 25_000,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (compatible; SunkenBot/3.0; +https://mangalik.net/)",
      },
    });

    if (response.status >= 300) {
      response.data?.destroy?.();
      const location = response.headers?.location;
      if (!location || hop === REDIRECT_LIMIT) throw new Error("The image redirect could not be followed.");
      const next = new URL(location, currentUrl).href;
      if (!normalizeMangalikUrl(next)) throw new Error("The image redirect host is not allowed.");
      currentUrl = next;
      continue;
    }

    const extension = validateImageResponse(response);
    const finalPath = `${destination}.${extension}`;
    let receivedBytes = 0;
    const sizeLimit = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_IMAGE_BYTES) return callback(new Error("The image exceeded the download size limit."));
        callback(null, chunk);
      },
    });
    await pipeline(response.data, sizeLimit, createWriteStream(finalPath, { flags: "wx" }));
    return finalPath;
  }
  throw new Error("The image redirect limit was exceeded.");
}

async function sendImageBatch(api, files, { mangaTitle, chapter, index, total, chapterUrl, threadID, replyToID }) {
  const firstPage = (index - 1) * MAX_IMAGES_PER_MESSAGE + 1;
  const lastPage = firstPage + files.length - 1;
  const body = `📖 ${mangaTitle} — الفصل ${chapter} (${index}/${total})\nالصفحات ${firstPage}–${lastPage}\n${chapterUrl}`;
  const streams = files.map(file => fs.createReadStream(file));
  try {
    await send(api, { body, attachment: streams }, threadID, index === 1 ? replyToID : null);
  } finally {
    for (const stream of streams) {
      if (!stream.closed) stream.destroy();
    }
  }
}

function userFacingError(error) {
  if (error?.code === "FIRECRAWL_NOT_CONFIGURED") {
    return "⚠️ أمر mangalik غير مهيأ بعد. أضف مفاتيح Firecrawl في Render تحت FIRECRAWL_API (مفصولة بفواصل).";
  }
  if (error?.code === "MANGA_NOT_FOUND") {
    return "❌ لم أجد مانجا بهذا الاسم في Mangalik. جرّب الاسم كما يظهر في الموقع.";
  }
  if (error?.code === "MANGALIK_PAGE_NOT_FOUND" || error?.code === "NO_CHAPTER_IMAGES") {
    return "❌ لم أجد صور هذا الفصل في Mangalik. تحقق من اسم المانجا ورقم الفصل.";
  }
  if (error instanceof FirecrawlClientError) {
    return "❌ تعذر الاتصال بخدمة Firecrawl الآن. حاول مرة أخرى لاحقاً.";
  }
  if (error?.code === "NO_IMAGES_DOWNLOADED") {
    return "❌ تعذر تحميل صفحات الفصل من Mangalik. حاول مرة أخرى لاحقاً.";
  }
  return "❌ حدث خطأ أثناء جلب الفصل من Mangalik. حاول مرة أخرى لاحقاً.";
}

async function deliverChapter({ api, event, mangaTitle, chapter, chapterUrl, imageUrls }) {
  const { threadID, messageID } = event;
  const limitedUrls = imageUrls.slice(0, MAX_IMAGES_PER_CHAPTER);
  const truncated = limitedUrls.length < imageUrls.length;
  const totalBatches = Math.ceil(limitedUrls.length / MAX_IMAGES_PER_MESSAGE);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mangalik-"));
  let sentImages = 0;
  let failedImages = 0;

  try {
    for (let offset = 0; offset < limitedUrls.length; offset += MAX_IMAGES_PER_MESSAGE) {
      const batchIndex = Math.floor(offset / MAX_IMAGES_PER_MESSAGE) + 1;
      const urls = limitedUrls.slice(offset, offset + MAX_IMAGES_PER_MESSAGE);
      const downloaded = await downloadWithLimit(urls, (url, itemIndex) => {
        const filePrefix = path.join(tempDir, `page-${offset + itemIndex + 1}`);
        return downloadImage(url, filePrefix, chapterUrl);
      }, DOWNLOAD_CONCURRENCY);
      const validFiles = downloaded.filter(Boolean);
      failedImages += urls.length - validFiles.length;

      if (validFiles.length) {
        await sendImageBatch(api, validFiles, {
          mangaTitle,
          chapter,
          index: batchIndex,
          total: totalBatches,
          chapterUrl,
          threadID,
          replyToID: messageID,
        });
        sentImages += validFiles.length;
      }

      await Promise.allSettled(validFiles.map(file => fs.remove(file)));
      if (offset + MAX_IMAGES_PER_MESSAGE < limitedUrls.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (failedImages) {
      logger.warn("mangalik image downloads were partial", {
        threadID: String(threadID),
        failedImages,
        sentImages,
      });
    }
    if (!sentImages) throw new MangalikCommandError("NO_IMAGES_DOWNLOADED");

    if (failedImages || truncated) {
      const note = truncated
        ? `⚠️ تم إرسال أول ${MAX_IMAGES_PER_CHAPTER} صفحة فقط؛ الفصل يتجاوز الحد الآمن.`
        : `⚠️ تعذر تحميل ${failedImages} من صفحات الفصل؛ أُرسلت الصفحات المتاحة.`;
      await send(api, note, threadID, null);
    }
  } finally {
    await fs.remove(tempDir).catch(() => {});
  }
}

export default {
  config: {
    name: "mangalik",
    aliases: ["mangalek", "مانجاليك"],
    version: "1.0.0",
    author: "OpenAI",
    countDown: 20,
    role: 0,
    category: "مانجا وروايات",
    description: "جلب فصل من موقع Mangalik وإرساله كحزم صور (14 صورة كحد أقصى لكل رسالة)",
    usage: ["{pn}mangalik <اسم المانجا> <رقم الفصل> — مثال: {pn}mangalik SPY×FAMILY 138"],
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, messageID, senderID } = event;
    let phase = "validate";

    try {
      if (!args?.length || args.length < 2) {
        await send(api, "📖 الاستخدام: mangalik <اسم المانجا> <رقم الفصل>\nمثال: mangalik SPY×FAMILY 138", threadID, messageID);
        return;
      }

      const rawChapter = String(args.at(-1)).trim();
      if (!/^\d+(?:[._-]\d+)?$/.test(rawChapter)) {
        await send(api, "❗ أدخل رقم فصل صحيحاً، مثل: 138 أو 139.2", threadID, messageID);
        return;
      }
      const rawTitle = args.slice(0, -1).join(" ").trim();
      if (!rawTitle || rawTitle.length > 100) {
        await send(api, "❗ اكتب اسم المانجا (بحد أقصى 100 حرف) ورقم الفصل.", threadID, messageID);
        return;
      }

      await send(api, `⏳ أبحث عن ${rawTitle} — الفصل ${rawChapter} في Mangalik...`, threadID, messageID);
      phase = "search";
      const manga = await searchManga(rawTitle);
      if (!manga) throw new MangalikCommandError("MANGA_NOT_FOUND");

      phase = "chapter";
      const { chapterUrl, imageUrls } = await getChapterPage(manga, rawChapter);
      phase = "download_and_send";
      await deliverChapter({
        api,
        event,
        mangaTitle: manga.title || rawTitle,
        chapter: rawChapter,
        chapterUrl,
        imageUrls,
      });
    } catch (error) {
      logger.error("mangalik command failed", {
        command: "mangalik",
        phase,
        threadID: String(threadID),
        senderID: String(senderID),
        errorName: error?.name || "Error",
        errorCode: error?.code || null,
        firecrawlStatus: error instanceof FirecrawlClientError ? error.statusCode : error?.statusCode || null,
        firecrawlKeyIndex: error instanceof FirecrawlClientError ? error.keyIndex : null,
        error: getSafeErrorMessage(error),
      });
      let notified = false;
      try {
        await send(api, userFacingError(error), threadID, messageID);
        notified = true;
      } catch {
        // Router will issue its generic error reply if this error message could not be sent.
      }
      const reported = makeReportedError();
      reported.userNotified = notified;
      throw reported;
    }
  },
};
