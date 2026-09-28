import fs from "fs-extra";
import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import http from "./fetchHttp.js";
import vreden from "@vreden/youtube_scraper";
import { searchVideos, downloadAudio, downloadVideo, normalizeYoutubeUrl } from "./ytEngine.js";

async function streamToTempFile(url, prefix, ext) {
  const filePath = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${randomUUID()}.${ext}`);
  try {
    const response = await http.get(url, {
      responseType: "stream",
      timeout: 120000,
      headers: { Accept: "video/mp4,audio/mpeg,*/*", "User-Agent": "Mozilla/5.0" },
    });
    await pipeline(response.data, fs.createWriteStream(filePath));
    const stat = await fs.stat(filePath);
    if (!stat.size) throw new Error("الملف فارغ.");
    return filePath;
  } catch (error) {
    await fs.remove(filePath).catch(() => {});
    throw error;
  }
}

function normalizeSearchResult(item) {
  if (!item || typeof item !== "object") return null;
  const url = item.url || (item.videoId
    ? `https://www.youtube.com/watch?v=${item.videoId}`
    : null);
  if (!url) return null;
  return {
    url,
    title: item.title || item.name || "YouTube video",
    duration: item.duration?.seconds || item.seconds || item.duration || 0,
    uploader: item.author?.name || item.author || item.channel?.name || item.channel || "",
    thumbnail: item.thumbnail || item.image || item.bestThumbnail?.url || null,
    views: item.views || item.viewCount || 0,
  };
}

const vredenProvider = {
  name: "vreden-youtube-scraper",
  async search(query, limit = 10) {
    const result = await vreden.search(query);
    if (!result?.status || !Array.isArray(result.results)) {
      throw new Error(result?.message || "لا توجد نتائج من Vreden");
    }
    const items = result.results.map(normalizeSearchResult).filter(Boolean).slice(0, Math.max(1, limit));
    if (!items.length) throw new Error("لا توجد نتائج");
    return items;
  },
  async download(url, wantMp4) {
    const result = wantMp4
      ? await vreden.ytmp4(url, 360)
      : await vreden.ytmp3(url, 128);
    if (!result?.status || !result.download?.url) {
      throw new Error(result?.message || "لم يُرجع Vreden رابط تحميل");
    }
    const metadata = result.metadata || {};
    const filePath = await streamToTempFile(
      result.download.url,
      "vreden-yt",
      wantMp4 ? "mp4" : "mp3",
    );
    return {
      filePath,
      title: metadata.title || result.download.filename || "YouTube media",
      duration: metadata.seconds || metadata.duration || 0,
      uploader: metadata.author?.name || metadata.author || "",
    };
  },
};

const engineProvider = {
  name: "yozora-engine",
  async search(query, limit) {
    const results = await searchVideos(query, limit);
    if (!results?.length) throw new Error("لا توجد نتائج");
    return results;
  },
  async download(url, wantMp4) {
    const result = wantMp4 ? await downloadVideo(url) : await downloadAudio(url);
    return {
      filePath: result.filePath,
      title: result.title || "media",
      duration: result.duration || 0,
      uploader: result.uploader || "",
    };
  },
};

const YT_DLP_STREAM_BASE = "https://yt-dlp-stream.onrender.com/api";

function parseYtDlpStreamResult(data) {
  if (!data || typeof data !== "object") {
    return { title: "بدون عنوان", author: "", mp4Url: null, mp3Url: null };
  }
  const media = data.media && typeof data.media === "object" && !Array.isArray(data.media)
    ? data.media
    : {};
  const getUrl = value => typeof value === "string"
    ? value
    : value && typeof value.url === "string" ? value.url : null;
  return {
    title: data.title || "بدون عنوان",
    author: data.author || data.channel || "",
    mp4Url: getUrl(media.mp4) || getUrl(data.mp4),
    mp3Url: getUrl(media.mp3) || getUrl(data.mp3),
  };
}

const ytDlpStreamProvider = {
  name: "yt-dlp-stream",
  async search(query, limit) {
    const url = `${YT_DLP_STREAM_BASE}/v3/q?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`;
    const response = await http.get(url, { timeout: 25000 });
    const data = response.data;
    const list = Array.isArray(data) ? data
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data?.data) ? data.data
      : [];
    const items = list.map(normalizeSearchResult).filter(Boolean);
    if (!items.length) throw new Error("لا توجد نتائج");
    return items;
  },
  async download(url, wantMp4) {
    const response = await http.get(`${YT_DLP_STREAM_BASE}/v2/q?url=${encodeURIComponent(url)}`, {
      timeout: 30000,
    });
    const raw = Array.isArray(response.data) ? response.data[0] : response.data;
    const parsed = parseYtDlpStreamResult(raw || {});
    const mediaUrl = wantMp4 ? parsed.mp4Url : parsed.mp3Url;
    if (!mediaUrl) throw new Error("الرابط غير متاح عبر هذا المزوّد");
    const filePath = await streamToTempFile(mediaUrl, "yt-dlp", wantMp4 ? "mp4" : "mp3");
    return { filePath, title: parsed.title, duration: 0, uploader: parsed.author };
  },
};

const CCPROJECT_BASE = "https://ccproject.serv00.net/ytdl2.php";
const ccProjectProvider = {
  name: "ccproject",
  async download(url, wantMp4) {
    const type = wantMp4 ? "mp4" : "mp3";
    const response = await http.get(CCPROJECT_BASE, {
      params: { url, type },
      timeout: 30000,
    });
    const data = response.data;
    if (!data || typeof data !== "object") throw new Error("استجابة غير متوقعة من الـ API الخارجي");
    if (!data.download) throw new Error(data.error || "لم يُرجع الـ API رابط تحميل");
    const filePath = await streamToTempFile(data.download, "ydl", type);
    return { filePath, title: data.title || "بدون عنوان", duration: 0, uploader: "" };
  },
};

// Vreden is primary, followed by the previous XL provider and the same stream fallback as F.
export const providers = [vredenProvider, engineProvider, ytDlpStreamProvider, ccProjectProvider];

export async function searchWithFallback(query, limit = 10) {
  const errors = [];
  for (const provider of providers) {
    if (typeof provider.search !== "function") continue;
    try {
      return await provider.search(query, limit);
    } catch (error) {
      errors.push(`${provider.name}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join(" | ") || "تعذّر البحث عبر جميع المزوّدين");
}

export async function downloadWithFallback(url, wantMp4) {
  const normalizedUrl = normalizeYoutubeUrl(url);
  const errors = [];
  for (const provider of providers) {
    if (typeof provider.download !== "function") continue;
    try {
      const result = await provider.download(normalizedUrl, wantMp4);
      return { ...result, provider: provider.name };
    } catch (error) {
      errors.push(`${provider.name}: ${error?.message || error}`);
    }
  }
  throw new Error(errors.join(" | ") || "تعذّر التحميل عبر جميع المزوّدين");
}

export async function cleanTemp(filePath) {
  try {
    if (filePath && await fs.pathExists(filePath)) await fs.remove(filePath);
  } catch (_) {}
}

export const $plugin = {
  name: "xx-utils-yt-providers",
  meta: { category: "utils", path: "utils/ytProviders.js" },
  setup(_ctx) {},
};
