
import fs from "fs";

import path from "path";

function hasAnyAppStateFile(projectRoot) {
    if (!projectRoot) return false;
    for (let i = 1; i <= 20; i++) {
        const suffix = i === 1 ? "" : String(i);
        if (fs.existsSync(path.join(projectRoot, `appstate${suffix}.json`))) return true;
    }
    return false;
}

function buildChecks(projectRoot) {
    return [ {
        level: "warn",
        key: null,
        label: "FB credentials",
        test: () => Boolean(process.env.APPSTATE?.trim()),
        message: "لا يوجد AppState صالح — أضف appstate1.json أو APPSTATE قبل التشغيل."
    }, {
        level: "warn",
        key: "HF_SPACE_URL",
        label: "HF_SPACE_URL",
        message: "أوامر chess/fb/gemini/groq/manga/novel/pin/song/sub/tts لن تعمل"
    }, {
        level: "warn",
        key: "INTERNAL_TOKEN",
        label: "INTERNAL_TOKEN",
        message: "طلبات hf-space ستُرفض بـ 401، وواجهات /yt/* ستبقى معطّلة (503)"
    } ];
}

export function checkEnv(projectRoot) {
    let hasCritical = false;
    for (const check of buildChecks(projectRoot)) {
        const ok = check.test ? check.test() : !!(process.env[check.key] || "").trim();
        if (ok) continue;
        if (check.level === "critical") {
            console.error(`[ENV] ❌ CRITICAL — ${check.label}: ${check.message}`);
            hasCritical = true;
        } else if (check.level === "warn") {
            console.warn(`[ENV] ⚠️  ${check.label}: ${check.message}`);
        } else {
            console.log(`[ENV] ℹ️  ${check.label}: ${check.message}`);
        }
    }
    if (hasCritical) {
        console.error("[ENV] أضف APPSTATE صالحاً أو FACEBOOK_EMAIL/FACEBOOK_PASSWORD إلى متغيرات البيئة قبل التشغيل");
    }
}

const hasFallbackAuth = Boolean(process.env.FACEBOOK_EMAIL && process.env.FACEBOOK_PASSWORD);
if (process.env.FACEBOOK_EMAIL && !process.env.FACEBOOK_PASSWORD) console.warn("[ENV] ⚠️ FACEBOOK_EMAIL موجود بدون FACEBOOK_PASSWORD");
if (process.env.FACEBOOK_PASSWORD && !process.env.FACEBOOK_EMAIL) console.warn("[ENV] ⚠️ FACEBOOK_PASSWORD موجود بدون FACEBOOK_EMAIL");
if (hasFallbackAuth) console.log("[ENV] ℹ️ تسجيل الدخول الاحتياطي email/password مفعّل");

export const $plugin = {
    name: "xx-utils-env-check",
    meta: {
        category: "utils",
        path: "utils/envCheck.js"
    },
    setup(_ctx) {}
};