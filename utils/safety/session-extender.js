
import { EventEmitter } from "node:events";
import { Agent as HttpsAgent } from "node:https";
import axios from "axios";
import {
  checkAppStateExpiry,
  persistAppState,
  extendCookieExpiry,
} from "../appStatePersist.js";

const KEEP_ALIVE_INTERVAL_MS  = 13 * 60 * 1_000;

const HEALTH_CHECK_RELAXED_MS = 45 * 60 * 1_000;
const HEALTH_CHECK_NORMAL_MS  = 20 * 60 * 1_000;
const HEALTH_CHECK_URGENT_MS  = 10 * 60 * 1_000;

const REFRESH_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1_000;   // 14 يوم
const CRITICAL_THRESHOLD_MS =  3 * 24 * 60 * 60 * 1_000;  //  3 أيام

/** circuit breaker */
const MAX_CONSECUTIVE_FAILS = 5;
const CIRCUIT_BREAKER_MS    = 45 * 60 * 1_000;

/** [FIX-4] نقطة keep-alive تُحافظ على الجلسة دون تسجيل نشاط مرئي */
const KEEPALIVE_ENDPOINT = "https://www.facebook.com/messages/";

/** User-Agent موحَّد */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/127.0.0.0 Safari/537.36";

// اتصال HTTP طويل العمر خاص بطلبات keep-alive/warmup.
const KEEPALIVE_AGENT = new HttpsAgent({
  keepAlive: true,
  maxSockets: 4,
  maxFreeSockets: 2,
  timeout: 30_000,
});

// ─────────────────────────────────────────────────────────────────────────────

export class SessionExtender extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {object}   opts.api              — كائن api من fca-nx
   * @param {number}   opts.botIndex
   * @param {object}   [opts.cookieRefresher]
   * @param {object}   [opts.sessionGuard]
   * @param {Function} [opts.onExtended]
   * @param {Function} [opts.onAppStateSave]
   * @param {Function} [opts.onCritical]
   * @param {number}   [opts.refreshThresholdMs]
   * @param {number}   [opts.keepAliveIntervalMs]
   */
  constructor(opts = {}) {
    super();
    this._api             = opts.api;
    this._botIndex        = opts.botIndex ?? 1;
    this._cookieRefresher = opts.cookieRefresher ?? null;
    this._sessionGuard    = opts.sessionGuard    ?? null;
    this._onExtended      = typeof opts.onExtended      === "function" ? opts.onExtended      : null;
    this._onAppStateSave  = typeof opts.onAppStateSave  === "function" ? opts.onAppStateSave  : null;
    this._onCritical      = typeof opts.onCritical      === "function" ? opts.onCritical      : null;
    this._threshold       = opts.refreshThresholdMs ?? REFRESH_THRESHOLD_MS;
    this._healthCheckMs   = opts.healthCheckIntervalMs ?? HEALTH_CHECK_NORMAL_MS;

    this._keepAliveMs = opts.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS;

    this._label          = `Bot-${this._botIndex}`;
    this._healthTimer = this._keepAliveTimer = this._startupTimer = null;
    this._running        = false;

    this._extensions     = 0;
    this._keepAlives     = 0;
    this._lastExtension  = null;
    this._lastKeepAlive  = null;
    this._startTime      = null;
    this._totalFailCount = 0;

    this._consecutiveFails = 0;
    this._circuitOpen      = false;
    this._circuitOpenUntil = 0;

    this._sessionHealthy   = true;
    this._lastHealthStatus = null;
  }

  // ── واجهة عامة ─────────────────────────────────────────────────────────────

  start() {
    if (this._running) return this;
    this._running   = true;
    this._startTime = Date.now();

    // فحص خفيف بعد 30 ثانية
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      if (this._running) void this._doHealthCheck(false, true);
    }, 30_000);
    this._startupTimer.unref?.();

    this._scheduleHealthCheck();
    this._scheduleKeepAlive();

    const kaMin = Math.round(this._keepAliveMs / 60_000);
    console.log(`[EXTENDER:${this._label}] ▶️ نشط | keep-alive ${kaMin}د | refresh ${Math.round(this._threshold / 86_400_000)}ي`);
    return this;
  }

  stop() {
    this._running = false;
    for (const key of ["_healthTimer", "_keepAliveTimer", "_startupTimer"]) {
      if (this[key]) clearTimeout(this[key]);
      this[key] = null;
    }
    console.log(`[EXTENDER:${this._label}] ⏹️ متوقف`);
    return this;
  }

  async extendNow() { return this._doHealthCheck(true); }
  async pingNow()   { return this._doKeepAlive(true); }

  getStats() {
    const uptimeMs = this._startTime ? Date.now() - this._startTime : 0;
    return {
      running:          this._running,
      extensions:       this._extensions,
      keepAlives:       this._keepAlives,
      lastExtension:    this._lastExtension,
      lastKeepAlive:    this._lastKeepAlive,
      failCount:        this._consecutiveFails,
      totalFails:       this._totalFailCount,
      circuitOpen:      this._circuitOpen,
      sessionHealthy:   this._sessionHealthy,
      uptimeHours:      (uptimeMs / 3_600_000).toFixed(1),
      keepAliveEnabled: true, // [FIX-2] دائماً مُفعَّل
      keepAliveIntervalMin: Math.round(this._keepAliveMs / 60_000),
    };
  }

  // ── جدولة تكيّفية للـ health-check ─────────────────────────────────────────

  _scheduleHealthCheck() {
    if (!this._running) return;

    let interval;
    if (!this._sessionHealthy || this._circuitOpen) {
      interval = HEALTH_CHECK_URGENT_MS;
    } else if (this._lastHealthStatus?.expiring) {
      interval = HEALTH_CHECK_NORMAL_MS;
    } else {
      interval = this._healthCheckMs;
    }

    const jitter = (Math.random() * 0.3 - 0.15) * interval;
    const delay  = Math.max(60_000, Math.round(interval + jitter));

    this._healthTimer = setTimeout(() => {
      this._doHealthCheck(false).finally(() => this._scheduleHealthCheck());
    }, delay);
    this._healthTimer?.unref?.();
  }

  // ── جدولة keep-alive ───────────────────────────────────────────────────────

  _scheduleKeepAlive() {
    if (!this._running) return;

    // [FIX-3] أول ping بعد 3 دقائق (ليس 60 دقيقة)
    // [FIX-6] jitter ±3 دقائق فقط (ليس ±20 دقيقة التي كانت تُتيح تجاوز عمر الجلسة)
    const initial = this._keepAlives === 0
      ? 3 * 60 * 1_000
      : this._keepAliveMs + (Math.random() * 6 - 3) * 60_000;

    this._keepAliveTimer = setTimeout(() => {
      this._doKeepAlive(false).finally(() => this._scheduleKeepAlive());
    }, initial);
    this._keepAliveTimer?.unref?.();
  }

  // ── فحص الصحة الكامل ────────────────────────────────────────────────────────

  async _doHealthCheck(manual = false, lightweight = false) {
    const label = this._label;
    const now   = Date.now();

    if (!manual && this._circuitOpen && now < this._circuitOpenUntil) {
      const remaining = Math.round((this._circuitOpenUntil - now) / 60_000);
      console.log(`[EXTENDER:${label}] ⚡ Circuit breaker — ${remaining} دقيقة متبقية`);
      return;
    }

    if (this._circuitOpen && now >= this._circuitOpenUntil) {
      this._circuitOpen      = false;
      this._consecutiveFails = 0;
      console.log(`[EXTENDER:${label}] ✅ Circuit breaker أُغلق`);
    }

    try {
      let currentState = null;
      try { currentState = this._api?.getAppState?.(); } catch (_) {}

      if (!currentState?.length) {
        console.warn(`[EXTENDER:${label}] ⚠️ لا يمكن قراءة AppState`);
        this._recordFail("getAppState returned empty");
        return;
      }

      const expiryStatus = checkAppStateExpiry(currentState, this._threshold);
      this._lastHealthStatus = expiryStatus;

      const { expiring, critical, minTtlMs, expiresAt, expiringSoon } = expiryStatus;
      const daysLeft = isFinite(minTtlMs) ? (minTtlMs / 86_400_000).toFixed(1) : "∞";

      if (!lightweight) {
        console.log(
          `[EXTENDER:${label}] 🩺 فحص الجلسة${manual ? " (يدوي)" : ""} — ` +
          `${isFinite(minTtlMs) ? `تنتهي خلال ${daysLeft} يوم` : "كوكيز دائمة"}` +
          (expiringSoon.length ? ` ⚠️ ${expiringSoon.join(", ")}` : "")
        );
      }

      if (critical) {
        console.error(`[EXTENDER:${label}] 🚨 حالة حرجة! تجديد فوري...`);
        this._sessionHealthy = false;
        this._onCritical?.({ botIndex: this._botIndex, expiresAt });
        this.emit("critical", { expiresAt, criticalCookies: expiryStatus.criticalCookies });
        await this._refreshSession(expiresAt, manual, true);
      } else if (expiring || manual) {
        await this._refreshSession(expiresAt, manual, false);
      }

      await this._refreshFbDtsg();

      this._sessionGuard?.heartbeat();
      this._cookieRefresher?.heartbeat?.();
      this._sessionHealthy   = true;
      this._consecutiveFails = 0;

    } catch (err) {
      this._recordFail(err.message);
    }
  }

  _cookieHeader(state) {
    return state?.filter(c => c?.key && c?.value).map(c => `${c.key}=${c.value}`).join("; ") || "";
  }

  async _fbPing(url, cookieStr) {
    const resp = await axios.get(url, {
      timeout: 20_000, httpsAgent: KEEPALIVE_AGENT, maxRedirects: 5,
      validateStatus: () => true, responseType: "stream",
      headers: { Cookie: cookieStr, "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Connection": "keep-alive" }
    });
    resp.data?.resume?.();
    return resp.status;
  }

  // ── keep-alive عبر Axios مع اتصال HTTP keep-alive ── [FIX-4] ───────────────────────────────────
  /**
   * يُرسل طلب GET خفيف لـ Facebook مستخدماً الكوكيز من api.getAppState().
   * لا يعتمد على تفاصيل داخلية غير ثابتة في FCA.
   */
  async _doKeepAlive(manual = false) {
    const label = this._label;

    let state;
    try { state = this._api?.getAppState?.(); } catch (_) {}

    if (!state?.length) {
      // [FIX-4] تحذير واضح بدل الصمت
      console.warn(`[EXTENDER:${label}] ⚠️ keep-alive: لا يوجد AppState متاح`);
      return;
    }

    // بناء Cookie header من AppState
    const cookieStr = this._cookieHeader(state);

    if (!cookieStr) {
      console.warn(`[EXTENDER:${label}] ⚠️ keep-alive: الكوكيز فارغة`);
      return;
    }

    try {
      // تأخير عشوائي (2–5 ثوانٍ) لمحاكاة نشاط بشري طبيعي
      await _sleep(2_000 + Math.random() * 3_000);

      const status = await this._fbPing(KEEPALIVE_ENDPOINT, cookieStr);

      if (status < 200 || status >= 300) {
        console.warn(`[EXTENDER:${label}] ⚠️ keep-alive HTTP ${status}`);
        // لا نُوقف — HTTP 3xx طبيعي على Facebook
      }

      // تمديد تواريخ انتهاء الكوكيز محلياً بعد كل ping ناجح
      const freshState = this._api?.getAppState?.();
      if (freshState?.length) {
        const extended = extendCookieExpiry(freshState, 60);
        persistAppState(extended, "keep-alive");
      }

      this._keepAlives++;
      this._lastKeepAlive = new Date().toISOString();

      console.log(
        `[EXTENDER:${label}] 💓 keep-alive #${this._keepAlives}` +
        ` — HTTP ${status}` +
        (manual ? " (يدوي)" : "")
      );

      await this._saveCurrentAppState("keep-alive");
      this._sessionGuard?.heartbeat();

    } catch (e) {
      // خطأ شبكة مؤقت — لا يُوقف البوت
      console.warn(`[EXTENDER:${label}] ⚠️ keep-alive axios فشل: ${e.message}`);
    }
  }

  // ── تجديد الكوكيز ──────────────────────────────────────────────────────────

  async _refreshSession(expiresAt, manual, isCritical) {
    const label   = this._label;
    const urgency = isCritical ? "🔴 حرج" : "🟡 وقائي";
    const when    = expiresAt ? `(تنتهي: ${expiresAt.toISOString()})` : "";

    console.log(`[EXTENDER:${label}] 🔄 تجديد [${urgency}] ${when}${manual ? " — يدوي" : ""}...`);

    if (this._cookieRefresher) {
      await this._cookieRefresher.refresh();
    } else {
      // [FIX-4] warmup عبر Axios لا عبر _defaultFuncs
      await this._fetchWarmup(isCritical);
    }

    const freshState = this._api?.getAppState?.();
    if (freshState?.length) {
      const extended = extendCookieExpiry(freshState, 90);
      persistAppState(extended, "post-refresh");
    }

    this._extensions++;
    this._lastExtension  = new Date().toISOString();
    this._sessionHealthy = true;

    console.log(`[EXTENDER:${label}] ✅ تجديد #${this._extensions} — الجلسة مُمدَّدة`);
    this.emit("extended", { count: this._extensions, manual, critical: isCritical });
    this._onExtended?.({ count: this._extensions, manual, critical: isCritical });

    await this._saveCurrentAppState("session-refresh");
  }

  async _refreshFbDtsg() {
    try {
      if (typeof this._api?.refreshFbDtsg === "function")
        await this._api.refreshFbDtsg();
      else if (typeof this._api?.refreshFb_dtsg === "function")
        await this._api.refreshFb_dtsg();
    } catch (_) {}
  }

  /**
   * [FIX-4] Warmup داخلي عبر Axios — لا يحتاج _ctx أو _defaultFuncs
   */
  async _fetchWarmup(aggressive = false) {
    const label = this._label;
    let state;
    try { state = this._api?.getAppState?.(); } catch (_) {}
    if (!state?.length) return;

    const cookieStr = this._cookieHeader(state);

    const urls = aggressive
      ? [KEEPALIVE_ENDPOINT, "https://www.facebook.com/", KEEPALIVE_ENDPOINT]
      : [KEEPALIVE_ENDPOINT];

    for (const url of urls) {
      try {
        await _sleep(1_500 + Math.random() * 2_000);
        await this._fbPing(url, cookieStr);
      } catch (e) {
        console.warn(`[EXTENDER:${label}] ⚠️ warmup axios [${url}]: ${e.message}`);
      }
    }
  }

  async _saveCurrentAppState(reason = "auto") {
    try {
      const state = this._api?.getAppState?.();
      if (!state?.length) return;
      if (this._onAppStateSave) {
        this._onAppStateSave(state);
      } else {
        console.warn(`[EXTENDER:${this._label}] ⚠️ onAppStateSave غير مُمرَّر (${reason})`);
      }
    } catch (e) {
      console.warn(`[EXTENDER:${this._label}] ⚠️ فشل حفظ AppState (${reason}): ${e.message}`);
    }
  }

  // ── إدارة الأخطاء والـ circuit breaker ─────────────────────────────────────

  _recordFail(errMsg = "unknown") {
    this._consecutiveFails++;
    this._totalFailCount++;

    console.warn(
      `[EXTENDER:${this._label}] ❌ فشل (${this._consecutiveFails}/${MAX_CONSECUTIVE_FAILS}): ${errMsg}`
    );

    if (this._consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      this._circuitOpen      = true;
      this._circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
      this._consecutiveFails = 0;
      this._sessionHealthy   = false;

      const minutes = Math.round(CIRCUIT_BREAKER_MS / 60_000);
      console.error(
        `[EXTENDER:${this._label}] 🔌 Circuit breaker فُتح — ` +
        `توقف ${minutes} دقيقة ثم إعادة المحاولة`
      );
      this.emit("circuit_open", { openUntil: new Date(this._circuitOpenUntil) });
    }
  }

  // [FIX-2] حُذِف _keepAliveEnabled() — keep-alive دائماً نشط
}

// ── مساعدات ──────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionExtender(opts) {
  return new SessionExtender(opts);
}

export default SessionExtender;
