
import axios from "axios";
import { promises as dns } from "node:dns";
import net from "node:net";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

function _isPrivateIp(ip) {
    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
    }
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 0) return true;
    return false;
}

async function _assertSafeUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`[SSRF] Invalid URL: ${rawUrl}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`[SSRF] Disallowed protocol: ${parsed.protocol}`);
    }
    if (net.isIP(parsed.hostname) && _isPrivateIp(parsed.hostname)) {
        throw new Error(`[SSRF] Direct private IP blocked: ${parsed.hostname}`);
    }
    let records;
    try {
        records = await dns.lookup(parsed.hostname, { all: true });
    } catch (e) {
        throw new Error(`[SSRF] DNS resolution failed for ${parsed.hostname}: ${e.message}`);
    }
    for (const { address } of records) {
        if (_isPrivateIp(address)) {
            throw new Error(`[SSRF] Hostname ${parsed.hostname} resolves to private IP ${address} — blocked.`);
        }
    }
}

const _keepAliveAgents = {
    http: new HttpAgent({ keepAlive: true, maxSockets: 20 }),
    https: new HttpsAgent({ keepAlive: true, maxSockets: 20 })
};

const defaults = {
    baseURL: "",
    headers: {}
};

const interceptors = {
    request: [],
    response: []
};

function buildUrl(url, params, baseURL) {
    const isAbsolute = /^https?:\/\//i.test(String(url));
    let finalUrl = url;
    if (!isAbsolute && baseURL) {
        finalUrl = baseURL.replace(/\/+$/, "") + "/" + String(url).replace(/^\/+/, "");
    }
    if (!params) return finalUrl;
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const v of value) qs.append(key, v);
        } else {
            qs.set(key, String(value));
        }
    }
    const queryString = qs.toString();
    if (!queryString) return finalUrl;
    return finalUrl + (finalUrl.includes("?") ? "&" : "?") + queryString;
}

function defaultValidateStatus(status) {
    return status >= 200 && status < 300;
}

const TRANSIENT_NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "ERR_NETWORK",
    "ERR_SOCKET",
]);

function wrapNetworkError(error, timeout) {
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
        const err = new Error(`timeout of ${timeout}ms exceeded`);
        err.code = "ECONNABORTED";
        err.response = undefined;
        err.retryable = true;
        return err;
    }

    const originalCode = error?.code || error?.cause?.code;
    const err = new Error(error?.message || "Network Error");
    err.code = originalCode || "ENETWORK";
    err.cause = error?.cause || error;
    err.response = undefined;
    err.retryable = TRANSIENT_NETWORK_CODES.has(originalCode) || !originalCode;
    return err;
}

function isRetryable(err) {
    if (err.code === "ECONNABORTED" || err.code === "ENETWORK" || err.retryable) return true;
    return Boolean(err.response && err.response.status >= 500);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isPlainObject(data) {
    return data !== null && typeof data === "object" &&
        !(data instanceof Buffer) &&
        !(data instanceof URLSearchParams) &&
        !(typeof FormData !== "undefined" && data instanceof FormData) &&
        !(data instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(data);
}

function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function performRequest(config) {
    const {
        url,
        method = "GET",
        headers = {},
        params,
        data,
        timeout = 0,
        responseType = "json",
        validateStatus = defaultValidateStatus,
        baseURL = defaults.baseURL
    } = config;

    if (!url) throw new Error("axiosHttp: 'url' مطلوب");

    let finalUrl = buildUrl(url, params, baseURL);
    let currentMethod = method.toUpperCase();
    let currentData = data;
    let currentHeaders = { ...defaults.headers, ...headers };
    let response;

    for (let redirects = 0; redirects <= 5; redirects++) {
        await _assertSafeUrl(finalUrl);

        const finalHeaders = { ...currentHeaders };
        if (currentData !== undefined && currentMethod !== "GET" && currentMethod !== "HEAD" && isPlainObject(currentData) &&
            !Object.keys(finalHeaders).some(h => h.toLowerCase() === "content-type")) {
            finalHeaders["Content-Type"] = "application/json";
        }

        try {
            response = await axios.request({
                url: finalUrl,
                method: currentMethod,
                headers: finalHeaders,
                data: currentData,
                timeout,
                responseType,
                validateStatus: () => true,
                maxRedirects: 0,
                httpAgent: _keepAliveAgents.http,
                httpsAgent: _keepAliveAgents.https
            });
        } catch (error) {
            throw wrapNetworkError(error, timeout);
        }

        const status = response.status;
        const responseHeaders = response.headers || {};

        if (!isRedirect(status)) break;

        // Axios يعيد stream حتى مع maxRedirects=0؛ أغلق جسم استجابة redirect
        // قبل متابعة الرابط حتى لا تبقى sockets معلّقة.
        if (responseType === "stream" && response.data?.destroy) {
            response.data.destroy();
        }

        const location = responseHeaders.location;
        if (!location) break;
        if (redirects === 5) throw new Error("تجاوز الحد الأقصى لإعادة التوجيه");

        const previousUrl = finalUrl;
        finalUrl = new URL(location, finalUrl).toString();

        // لا تُرسل بيانات الاعتماد إلى origin مختلف عبر redirect.
        try {
            const previousOrigin = new URL(previousUrl).origin;
            const nextOrigin = new URL(finalUrl).origin;
            if (previousOrigin !== nextOrigin) {
                for (const key of Object.keys(currentHeaders)) {
                    if (["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())) {
                        delete currentHeaders[key];
                    }
                }
            }
        } catch (_) {}

        if (status === 303 || ((status === 301 || status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")) {
            currentMethod = "GET";
            currentData = undefined;
        }
    }

    const status = response.status;
    const statusText = response.statusText || "";
    const resHeaders = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));

    if (!validateStatus(status)) {
        const err = new Error(`Request failed with status code ${status}`);
        err.code = `ERR_BAD_STATUS_${status}`;
        err.response = {
            status,
            statusText,
            headers: resHeaders,
            data: response.data
        };
        throw err;
    }

    return {
        data: response.data,
        status,
        statusText,
        headers: resHeaders
    };
}

async function request(config = {}) {
    let finalConfig = config;
    for (const fn of interceptors.request) {
        finalConfig = await fn(finalConfig) || finalConfig;
    }

    const retries = finalConfig.retries ?? 0;
    const retryDelay = finalConfig.retryDelay ?? 300;
    let attempt = 0;

    while (true) {
        try {
            let res = await performRequest(finalConfig);
            for (const fn of interceptors.response) {
                res = await fn(res) || res;
            }
            return res;
        } catch (err) {
            if (attempt < retries && isRetryable(err)) {
                attempt++;
                await sleep(retryDelay * attempt);
                continue;
            }
            throw err;
        }
    }
}

function get(url, config = {}) {
    return request({ ...config, url, method: "GET" });
}

function post(url, data, config = {}) {
    return request({ ...config, url, method: "POST", data });
}

function put(url, data, config = {}) {
    return request({ ...config, url, method: "PUT", data });
}

function del(url, config = {}) {
    return request({ ...config, url, method: "DELETE" });
}

export { _assertSafeUrl as assertSafeUrl };

export default Object.assign(request, {
    get,
    post,
    put,
    delete: del,
    request,
    defaults,
    interceptors
});

export const $plugin = {
    name: "xx-utils-axios-http",
    meta: {
        category: "utils",
        path: "utils/fetchHttp.js"
    },
    setup(_ctx) {}
};
