
const FB_ID_RE = /^\d{5,20}$/;

function isValidFbId(id) {
    return typeof id === "string" && FB_ID_RE.test(id.trim());
}

export { isValidFbId };

export const $plugin = {
    name: "xx-utils-validate",
    meta: {
        category: "utils",
        path: "utils/validate.js"
    },
    setup(_ctx) {}
};