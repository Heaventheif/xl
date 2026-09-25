import fs from "fs-extra";
import os from "os";
import path from "path";
import https from "https";
import http from "http";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { splitFile, cleanupParts, NEEDS_SPLIT } from "./mediaSplitter.js";
import { assertSafeUrl } from "./fetchHttp.js";
import { directSend, directSendParts } from "./directSend.js";

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT = 120_000;

async function fetchStream(url, redirectCount = 0) {
    if (redirectCount > MAX_REDIRECTS) throw new Error("تجاوز الحد الأقصى لإعادة التوجيه");
    await assertSafeUrl(url);

    return new Promise((resolve, reject) => {
        const lib = url.startsWith("https:") ? https : http;
        const req = lib.get(url, { timeout: REQUEST_TIMEOUT, headers: { "User-Agent": "Mozilla/5.0" } }, res => {
            const { statusCode = 0, headers } = res;
            if (statusCode >= 300 && statusCode < 400) {
                res.resume();
                const location = headers.location;
                if (!location) return reject(new Error("إعادة توجيه بدون Location header"));
                return fetchStream(new URL(location, url).toString(), redirectCount + 1).then(resolve, reject);
            }
            if (statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${statusCode} من الخادم`));
            }
            resolve({ stream: res, contentLength: Number.parseInt(headers["content-length"] || "0", 10) || 0 });
        });
        req.once("error", reject);
        req.once("timeout", () => req.destroy(new Error("انتهت مهلة الاتصال")));
    });
}

async function downloadToTemp(url, ext = "mp4") {
    const { stream, contentLength } = await fetchStream(url);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
        stream.resume();
        throw new Error(`حجم الملف (${Math.round(contentLength / 1024 / 1024)}MB) يتجاوز الحد المسموح (${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB)`);
    }

    const tmpPath = path.join(os.tmpdir(), `media_${Date.now()}_${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, "") || "mp4"}`);
    const writer = fs.createWriteStream(tmpPath);
    let bytesReceived = 0;
    const guard = new Transform({
        transform(chunk, _encoding, callback) {
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_DOWNLOAD_BYTES) {
                callback(new Error(`الملف تجاوز الحد الأقصى (${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB) أثناء التحميل`));
                return;
            }
            callback(null, chunk);
        }
    });

    try {
        await pipeline(stream, guard, writer);
    } catch (error) {
        await fs.remove(tmpPath).catch(() => {});
        throw error;
    }

    const stat = await fs.stat(tmpPath);
    return { tmpPath, size: stat.size, contentLength };
}

async function streamAndSend(api, threadID, mediaUrl, title, ext = "mp4", replyToID = undefined) {
    let tmpPath;
    let partPaths = [];
    try {
        const downloaded = await downloadToTemp(mediaUrl, ext);
        tmpPath = downloaded.tmpPath;
        console.log(`[MEDIA_STREAM] تم تحميل ${Math.round(downloaded.size / 1024 / 1024 * 10) / 10}MB (${ext})`);

        if (NEEDS_SPLIT(downloaded.size)) {
            partPaths = await splitFile(tmpPath, ext);
            const streams = partPaths.map(p => ({ stream: fs.createReadStream(p), reopen: () => fs.createReadStream(p) }));
            const { sent } = await directSendParts(api, threadID, title, streams, replyToID);
            return sent > 0;
        }

        return await directSend(api, threadID, { attachment: fs.createReadStream(tmpPath) }, replyToID);
    } catch (e) {
        console.error("[MEDIA_STREAM] خطأ:", e.message?.substring(0, 200));
        if (e.code === "FILE_TOO_LARGE") {
            await global.safeSend(api, `⚠️ ${e.message}`, threadID, null, replyToID).catch(() => {});
            return true;
        }
        return false;
    } finally {
        if (tmpPath) await fs.remove(tmpPath).catch(() => {});
        if (partPaths.length) await cleanupParts(partPaths).catch(() => {});
    }
}

export { streamAndSend, downloadToTemp, fetchStream };

export const $plugin = {
    name: "xx-utils-media-stream",
    meta: { category: "utils", path: "utils/mediaStream.js" },
    setup(_ctx) {}
};
