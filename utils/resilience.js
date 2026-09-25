
const SENSITIVE = /(?:appstate|cookie|token|authorization|password|secret|api[_-]?key|service[_-]?role)/i;

function serialize(value) {
    if (value instanceof Error) return {
        name: value.name,
        message: value.message,
        stack: value.stack
    };
    if (typeof value === "string") return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

function log(level, message, context = {}) {
    const safeContext = Object.fromEntries(Object.entries(context || {}).map((([key, value]) => [ key, SENSITIVE.test(key) ? "[REDACTED]" : serialize(value) ])));
    const line = JSON.stringify({
        ts: (new Date).toISOString(),
        level: level,
        message: message,
        ...safeContext
    });
    const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    writer(line);
}

export const logger = {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context)
};

export function backoffDelay(attempt, {baseMs: baseMs = 500, capMs: capMs = 3e4, jitter: jitter = true} = {}) {
    const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 10));
    return jitter ? Math.max(baseMs, Math.floor(Math.random() * ceiling)) : ceiling;
}

export async function withRetry(operation, options = {}) {
    const {retries: retries = 3, baseMs: baseMs = 500, capMs: capMs = 3e4, label: label = "operation", shouldRetry: shouldRetry = () => true, onRetry: onRetry} = options;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= retries || !shouldRetry(error, attempt)) throw error;
            const delayMs = backoffDelay(attempt, {
                baseMs: baseMs,
                capMs: capMs
            });
            logger.warn("retry scheduled", {
                label: label,
                attempt: attempt + 1,
                delayMs: delayMs,
                error: error?.message || String(error)
            });
            await (onRetry?.({
                error: error,
                attempt: attempt,
                delayMs: delayMs
            }));
            await new Promise((resolve => setTimeout(resolve, delayMs)));
        }
    }
    throw lastError;
}

export function isTransientError(error) {
    const text = String(error?.message || error || "").toLowerCase();
    const status = Number(error?.status || error?.statusCode || error?.code);
    return status === 408 || status === 425 || status === 429 || status >= 500 || /timeout|econnreset|enetunreach|eai_again|connection refused|socket|network|temporar|closed|disconnect/.test(text);
}

global.resilienceLogger = logger;

global.withRetry = withRetry;