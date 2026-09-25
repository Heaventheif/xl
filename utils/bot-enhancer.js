
function nextLogNormal(median, sigma) {
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random() || 1e-10;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return median * Math.exp(sigma * z);
}

function getTypingDuration(text) {
    if (typeof text !== "string") text = text && typeof text.body === "string" ? text.body : "";
    if (!text) return 0;
    return Math.min(nextLogNormal(350, .35), 700);
}

const TYPING_INDICATOR_PROBABILITY = .78;

export default function enhanceBot() {
    if (global.safeSend.__humanized) return;
    const baseSend = global.safeSend;
    const enhancedSend = async function enhancedSend(apiInstance, body, threadID, callback, messageID) {
        if (!body) return baseSend(apiInstance, body, threadID, callback, messageID);
        const textBody = typeof body === "string" ? body : typeof body?.body === "string" ? body.body : "";
        const isAttachmentOnly = typeof body === "object" && !!body?.attachment && !textBody;
        if (isAttachmentOnly) return baseSend(apiInstance, body, threadID, callback, messageID);
        const typingMs = getTypingDuration(textBody);
        const shouldSendIndicator = typingMs > 0 && Math.random() < TYPING_INDICATOR_PROBABILITY && typeof apiInstance?.sendTypingIndicator === "function";
        if (shouldSendIndicator) {
            try {
                apiInstance.sendTypingIndicator(threadID, true, {
                    duration: typingMs
                });
            } catch (err) {
                console.warn("[ENHANCER] sendTypingIndicator فشل:", err?.message);
            }
            await new Promise((resolve => setTimeout(resolve, 20 + Math.random() * 60)));
        }
        return baseSend(apiInstance, body, threadID, callback, messageID);
    };
    enhancedSend.__humanized = true;
    global.safeSend = enhancedSend;
    console.log("[✅ ENHANCER] محاكاة الكتابة نشطة (إيقاع بشري غير متوقع)");
}

export const $plugin = {
    name: "xx-utils-bot-enhancer",
    meta: {
        category: "utils",
        path: "utils/bot-enhancer.js"
    },
    setup(_ctx) {}
};