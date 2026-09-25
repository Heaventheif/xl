const BASE_URL = (process.env.CODECRAFT_BASE_URL || "https://www.codecraftapi.com/v1").replace(/\/+$/, "");
const API_KEY = () => process.env.CODECRAFT_API_KEY?.trim();
const DEFAULT_MODEL = () => process.env.CODECRAFT_MODEL?.trim() || "claude-opus-4.8";
const TIMEOUT_MS = 60_000;
const MAX_HISTORY = 12;
const MAX_THREADS = 500;

const modelByThread = new Map();
const historyByThread = new Map();
let modelsCache = null;
let modelsCacheAt = 0;

function remember(map, key, value) {
    if (map.has(key)) map.delete(key);
    while (map.size >= MAX_THREADS) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
}

function getModel(threadID) {
    return modelByThread.get(threadID) || DEFAULT_MODEL();
}

function cleanText(value) {
    return String(value || "").replace(/\u0000/g, "").trim();
}

async function request(path, options = {}) {
    const key = API_KEY();
    if (!key) throw new Error("CODECRAFT_API_KEY غير مضبوط في متغيرات البيئة.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${BASE_URL}${path}`, {
            ...options,
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        });
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            data = { error: { message: text.slice(0, 500) } };
        }
        if (!response.ok) {
            const message = data?.error?.message || `HTTP ${response.status}`;
            throw new Error(`CodeCraft ${response.status}: ${message}`);
        }
        return data;
    } catch (error) {
        if (error.name === "AbortError") throw new Error("انتهت مهلة طلب CodeCraft.");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function getModels() {
    if (modelsCache && Date.now() - modelsCacheAt < 5 * 60_000) return modelsCache;
    const data = await request("/models", { method: "GET" });
    modelsCache = Array.isArray(data?.data) ? data.data : [];
    modelsCacheAt = Date.now();
    return modelsCache;
}

function findModel(models, name) {
    const wanted = cleanText(name).toLowerCase();
    if (!wanted) return null;
    return models.find(model => {
        const id = String(model.id || "").toLowerCase();
        const label = String(model.name || "").toLowerCase();
        return id === wanted || label === wanted;
    }) || null;
}

function formatModels(models) {
    if (!models.length) return "❌ لم يتم العثور على نماذج متاحة.";
    return [
        "🤖 نماذج CodeCraft المتاحة",
        "",
        ...models.map((model, index) => {
            const caps = Array.isArray(model.capabilities) ? model.capabilities.join(", ") : "";
            const context = model.context_window ? ` • ${Number(model.context_window).toLocaleString()} ctx` : "";
            return `${index + 1}. ${model.id}${context}${caps ? `\n   ${caps}` : ""}`;
        })
    ].join("\n");
}

function formatError(error) {
    const message = error?.message || "خطأ غير معروف";
    if (message.includes("401")) return "❌ مفتاح CodeCraft غير صالح أو منتهي.";
    if (message.includes("403")) return "❌ مفتاح CodeCraft لا يملك الصلاحية المطلوبة.";
    if (message.includes("404")) return "❌ النموذج غير موجود أو غير متاح لهذا المفتاح.";
    if (message.includes("429")) return "⏳ تم تجاوز حد الطلبات في CodeCraft، حاول لاحقاً.";
    if (message.includes("402")) return "💳 لا يوجد رصيد/استخدام متاح في CodeCraft لهذا الطلب.";
    return `❌ ${message.slice(0, 300)}`;
}

async function complete(threadID, prompt) {
    const history = historyByThread.get(threadID) || [];
    const model = getModel(threadID);
    const messages = [
        { role: "system", content: "You are a helpful assistant. Answer clearly and concisely. Match the user's language." },
        ...history,
        { role: "user", content: prompt }
    ];

    const data = await request("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
            model,
            messages,
            max_tokens: 4096
        })
    });

    const reply = cleanText(data?.choices?.[0]?.message?.content);
    if (!reply) throw new Error("استجابة فارغة من CodeCraft.");

    const next = [
        ...history,
        { role: "user", content: prompt },
        { role: "assistant", content: reply }
    ].slice(-(MAX_HISTORY * 2));
    remember(historyByThread, threadID, next);
    return { reply, model, usage: data?.usage };
}

async function handle({ api, event, message, args }) {
    const threadID = event.threadID;
    const input = args.join(" ").trim();
    const parts = input.split(/\s+/);
    const sub = (parts[0] || "").toLowerCase();

    if (!API_KEY()) {
        return message.reply("❌ ضع CODECRAFT_API_KEY في متغيرات البيئة أولاً.");
    }

    if (sub === "models" || sub === "model" && parts.length === 1) {
        try {
            return message.reply(formatModels(await getModels()));
        } catch (error) {
            return message.reply(formatError(error));
        }
    }

    if (sub === "set" || sub === "model") {
        const requested = parts.slice(1).join(" ").trim();
        if (!requested) return message.reply(`النموذج الحالي: ${getModel(threadID)}\n\nاستخدم: cc set <model>`);
        try {
            const models = await getModels();
            const model = findModel(models, requested);
            if (!model) return message.reply(`❌ النموذج غير موجود.\n\nاستخدم: cc models`);
            remember(modelByThread, threadID, model.id);
            return message.reply(`✅ تم اختيار: ${model.id}`);
        } catch (error) {
            return message.reply(formatError(error));
        }
    }

    if (["clear", "مسح", "reset"].includes(sub)) {
        historyByThread.delete(threadID);
        return message.reply("🧹 تم مسح ذاكرة محادثة CodeCraft لهذه المجموعة.");
    }

    if (sub === "current" || sub === "info") {
        return message.reply(`🤖 CodeCraft\nالنموذج: ${getModel(threadID)}\nالعنوان: ${BASE_URL}`);
    }

    if (!input) {
        return message.reply([
            "🤖 CodeCraft API",
            "",
            `النموذج الحالي: ${getModel(threadID)}`,
            "",
            "cc <سؤالك> — محادثة",
            "cc models — قائمة النماذج",
            "cc set <model> — اختيار نموذج",
            "cc current — عرض النموذج الحالي",
            "cc مسح — مسح الذاكرة"
        ].join("\n"));
    }

    try {
        const result = await complete(threadID, input);
        return message.reply(`🤖 ${result.reply}\n\n— ${result.model}`);
    } catch (error) {
        console.error("[CC]", error.message);
        return message.reply(formatError(error));
    }
}

export default {
    config: {
        name: "cc",
        aliases: ["codecraft"],
        version: "1.0.0",
        author: "Sunken",
        countDown: 3,
        role: 0,
        category: "ذكاء اصطناعي",
        description: "الوصول إلى نماذج CodeCraft API عبر مفتاح API واحد",
        usage: [
            "{pn}cc <سؤالك>",
            "{pn}cc models — عرض النماذج المتاحة",
            "{pn}cc set <model> — اختيار نموذج للمجموعة",
            "{pn}cc current — النموذج الحالي",
            "{pn}cc مسح — مسح الذاكرة"
        ]
    },
    onStart: async ({ api, event, args, message }) => handle({ api, event, args, message })
};
