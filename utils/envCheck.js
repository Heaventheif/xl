
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
        key: "APPSTATE",
        label: "APPSTATE",
        test: () => Boolean(
            process.env.APPSTATE?.trim() ||
            (process.env.APPSTATE_FILE && fs.existsSync(path.resolve(projectRoot, process.env.APPSTATE_FILE))) ||
            hasAnyAppStateFile(projectRoot)
        ),
        message: "لا يوجد AppState صالح — ضع APPSTATE أو appstate.json."
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
        console.error("[ENV] أضف APPSTATE صالحاً أو appstate.json قبل التشغيل");
    }
}


export const $plugin = {
    name: "xx-utils-env-check",
    meta: {
        category: "utils",
        path: "utils/envCheck.js"
    },
    setup(_ctx) {}
};