export const RENDER_KEEP_ALIVE_INTERVAL_MS = 13 * 60 * 1_000;

const INITIAL_PING_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

function getHealthUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL("/health", baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Keeps a Render Free web service active by sending a low-frequency inbound
 * request to its own health endpoint. This is intentionally separate from
 * Facebook session keep-alives, which are disabled in this project.
 */
export function createRenderKeepAlive({
  enabled = process.env.RENDER === "true",
  baseUrl = process.env.RENDER_EXTERNAL_URL,
  intervalMs = RENDER_KEEP_ALIVE_INTERVAL_MS,
  initialDelayMs = INITIAL_PING_DELAY_MS,
  retryDelayMs = RETRY_DELAY_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console,
} = {}) {
  const url = enabled ? getHealthUrl(baseUrl) : null;
  let timer = null;
  let stopped = true;
  let inFlight = false;
  let activeController = null;
  let pingCount = 0;

  function schedule(delayMs) {
    if (stopped || !url) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      void ping();
    }, delayMs);
    timer?.unref?.();
  }

  async function ping() {
    if (stopped || !url || typeof fetchImpl !== "function" || inFlight) return false;

    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    let nextDelayMs = intervalMs;
    const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);
    timeout?.unref?.();

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { "user-agent": "SunkenBot-Render-KeepAlive/1.0" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw new Error(`health endpoint returned HTTP ${response?.status ?? "unknown"}`);
      }
      if (typeof response.arrayBuffer === "function") await response.arrayBuffer();
      else if (typeof response.text === "function") await response.text();

      pingCount += 1;
      logger.info?.(`[RENDER:KEEPALIVE] /health ping succeeded (#${pingCount})`);
      return true;
    } catch (error) {
      nextDelayMs = retryDelayMs;
      if (!stopped) {
        logger.warn?.(`[RENDER:KEEPALIVE] /health ping failed; retrying in ${Math.round(retryDelayMs / 1_000)}s: ${error?.message || error}`);
      }
      return false;
    } finally {
      clearTimeoutImpl(timeout);
      if (activeController === controller) activeController = null;
      inFlight = false;
      if (!stopped) schedule(nextDelayMs);
    }
  }

  function start() {
    if (!enabled) return stop;
    if (!url) {
      logger.warn?.("[RENDER:KEEPALIVE] Disabled: RENDER_EXTERNAL_URL is missing or invalid");
      return stop;
    }
    if (!stopped) return stop;

    stopped = false;
    logger.info?.(`[RENDER:KEEPALIVE] Active: ${url} every ${Math.round(intervalMs / 60_000)} minutes`);
    schedule(initialDelayMs);
    return stop;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    activeController?.abort();
    activeController = null;
  }

  async function pingNow() {
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    return ping();
  }

  return { start, stop, pingNow, url };
}

export function startRenderKeepAlive(options) {
  const keepAlive = createRenderKeepAlive(options);
  keepAlive.start();
  return () => keepAlive.stop();
}
