
function getHfBase() {
    const url = (process.env.HF_SPACE_URL || "").trim();
    if (!url) {
        throw new Error("HF_SPACE_URL غير مضبوط في متغيرات البيئة (Environment Variables)");
    }
    return url.replace(/\/+$/, "");
}

function getHfBaseOrNull() {
    try {
        return getHfBase();
    } catch (_) {
        return null;
    }
}

function getInternalToken() {
    return process.env.INTERNAL_TOKEN || "";
}

export { getHfBase, getHfBaseOrNull, getInternalToken };

export const $plugin = {
    name: "xx-utils-hf-client",
    meta: {
        category: "utils",
        path: "utils/hfClient.js"
    },
    setup(_ctx) {}
};