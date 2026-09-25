"use strict";
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const EventEmitter = require("events");
const models = require("../src/database/models");
const logger = require("../func/logger");
const { get, post, makeDefaults } = require("../src/utils/request");
const { CookieJar } = require("tough-cookie");
const { saveCookies, getAppState } = require("../src/utils/client");
const { getFrom } = require("../src/utils/constants");
const { loadConfig } = require("./config");

const { config } = loadConfig();
const { generateTOTP, normalizeSecret } = require("./totp");
const regions = [
  { code: "PRN", name: "Pacific Northwest Region", location: "Khu vực Tây Bắc Thái Bình Dương" },
  { code: "VLL", name: "Valley Region", location: "Valley" },
  { code: "ASH", name: "Ashburn Region", location: "Ashburn" },
  { code: "DFW", name: "Dallas/Fort Worth Region", location: "Dallas/Fort Worth" },
  { code: "LLA", name: "Los Angeles Region", location: "Los Angeles" },
  { code: "FRA", name: "Frankfurt", location: "Frankfurt" },
  { code: "SIN", name: "Singapore", location: "Singapore" },
  { code: "NRT", name: "Tokyo", location: "Japan" },
  { code: "HKG", name: "Hong Kong", location: "Hong Kong" },
  { code: "SYD", name: "Sydney", location: "Sydney" },
  { code: "PNB", name: "Pacific Northwest - Beta", location: "Pacific Northwest " }
];

const REGION_MAP = new Map(regions.map(r => [r.code, r]));

function parseRegion(html) {
  try {
    const m1 = html.match(/"endpoint":"([^"]+)"/);
    const m2 = m1 ? null : html.match(/endpoint\\":\\"([^\\"]+)\\"/);
    const raw = (m1 && m1[1]) || (m2 && m2[1]);
    if (!raw) return "PRN";
    const endpoint = raw.replace(/\\\//g, "/");
    const url = new URL(endpoint);
    const rp = url.searchParams ? url.searchParams.get("region") : null;
    return rp ? rp.toUpperCase() : "PRN";
  } catch {
    return "PRN";
  }
}

function mask(s, keep = 3) {
  if (!s) return "";
  const n = s.length;
  return n <= keep ? "*".repeat(n) : s.slice(0, keep) + "*".repeat(Math.max(0, n - keep));
}

/**
 * Local Facebook web login. Credentials never leave this process for a
 * third-party login service. If a TOTP secret is configured, the code is
 * generated locally and submitted only to Facebook's own checkpoint form.
 */
async function loginViaFacebookWeb(email, password, twoFactor = null, globalOptions = {}) {
  const jar = new CookieJar();
  const opts = globalOptions || {};
  const secret = normalizeSecret(twoFactor);
  const started = Date.now();
  const cheerio = require("cheerio");

  if (!email || !password) return { ok: false, message: "Please provide email and password" };

  const responseUrl = (res, fallback = "") => String(
    res?.request?.res?.responseUrl ||
    res?.request?.responseURL ||
    res?.request?.res?.req?.res?.responseUrl ||
    res?.headers?.location ||
    res?.config?.url ||
    fallback || ""
  );

  const bodyOf = (res) => String(res?.data ?? res?.body ?? "");

  const hasUserCookie = async () => {
    try {
      const urls = ["https://www.facebook.com/", "https://facebook.com/"];
      for (const url of urls) {
        const cookies = await jar.getCookies(url);
        if (cookies.some(c => (c.key === "c_user" || c.key === "i_user") && c.value)) return true;
      }
    } catch {}
    return false;
  };

  const formInfo = (html) => {
    const $ = cheerio.load(String(html || ""));
    const forms = [];
    $("form").each((_, el) => {
      const names = [];
      $(el).find("input[name]").each((__, input) => names.push(String($(input).attr("name") || "")));
      const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 180);
      forms.push({
        action: String($(el).attr("action") || ""),
        names,
        text
      });
    });
    return forms;
  };

  const isApprovalHtml = (html) => {
    const lower = String(html || "").toLowerCase();
    return /login-approval|approvals_code|name_action_selected|checkpointsubmitbutton|checkpoint\/|two-factor|two_factor|\b2fa\b/.test(lower);
  };

  const resolveAction = (form, fallback) => {
    let action = String(form?.attr("action") || fallback || "");
    try { return new URL(action, "https://www.facebook.com/").toString(); }
    catch { return fallback; }
  };

  const submitApproval = async (html, fallbackUrl) => {
    const $ = cheerio.load(String(html || ""));
    const candidates = $("form").filter((_, el) => {
      const names = $(el).find("input[name]").map((__, input) => String($(input).attr("name") || "")).get();
      const text = $(el).text();
      return names.some(n => /approvals_code|name_action_selected|checkpoint/i.test(n)) || /login approval|two-factor|security code|confirmation code/i.test(text);
    });
    const form = candidates.first().length ? candidates.first() : $("form").first();
    if (!form.length) return { handled: false, body: html, url: fallbackUrl };

    const data = {};
    form.find("input[name]").each((_, el) => {
      const name = String($(el).attr("name") || "");
      if (name) data[name] = String($(el).attr("value") || "");
    });

    const action = resolveAction(form, fallbackUrl || "https://www.facebook.com/checkpoint/");
    const names = Object.keys(data);
    const needsCode = names.some(n => /approvals_code|approval|2fa|two.?factor|code/i.test(n)) || isApprovalHtml(html);

    if (!needsCode) return { handled: false, body: html, url: action };
    if (!secret) {
      const err = new Error("Facebook requires 2FA approval; set FACEBOOK_2FA to the Base32 TOTP secret");
      err.error = "login-approval";
      err.loginUrl = action;
      throw err;
    }

    const code = await generateTOTP(secret);
    const codeField = names.includes("approvals_code") ? "approvals_code" :
      (names.find(n => /verification.?code|security.?code|two.?factor|2fa|^code$/i.test(n)) || "approvals_code");
    data[codeField] = code;

    if (names.includes("submit[Continue]")) data["submit[Continue]"] = data["submit[Continue]"] || "Continue";
    else if (names.includes("submit[Continue]")) data["submit[Continue]"] = "Continue";

    logger(chalk.italic(`🔐 Facebook 2FA challenge detected (${codeField})`), "info");
    const approvalResponse = await post(action, jar, data, opts);
    const approvalBody = bodyOf(approvalResponse);
    const approvalUrl = responseUrl(approvalResponse, action);

    if (await hasUserCookie()) return { handled: true, body: approvalBody, url: approvalUrl };
    if (/invalid|incorrect|wrong|expired/i.test(approvalBody) && /approvals_code|verification|security|two.?factor|2fa/i.test(approvalBody)) {
      throw new Error("Facebook rejected the generated TOTP code");
    }

    const after$ = cheerio.load(approvalBody);
    const reviewForms = after$("form").filter((_, el) => {
      const names = after$(el).find("input[name]").map((__, input) => String(after$(input).attr("name") || "")).get();
      return names.includes("name_action_selected") || /dont_save|save_browser|remember/i.test(after$(el).text());
    });
    if (reviewForms.first().length) {
      const review = reviewForms.first();
      const reviewData = {};
      review.find("input[name]").each((_, el) => {
        const name = String(after$(el).attr("name") || "");
        if (name) reviewData[name] = String(after$(el).attr("value") || "");
      });
      reviewData.name_action_selected = "dont_save";
      await post(resolveAction(review, approvalUrl), jar, reviewData, opts);
    }

    await get("https://www.facebook.com/", jar, null, opts);
    return { handled: true, body: approvalBody, url: approvalUrl };
  };

  try {
    const landing = await get("https://www.facebook.com/", jar, null, opts);
    const html = bodyOf(landing);
    const $ = cheerio.load(html);
    const loginForm = $("form").filter((_, el) => {
      const action = String($(el).attr("action") || "");
      return /login/i.test(action) || $(el).find('input[name="email"]').length || $(el).find('input[name="pass"]').length;
    }).first();

    if (!loginForm.length) throw new Error("Facebook login form not found");

    const form = {};
    loginForm.find("input[name]").each((_, el) => {
      const name = String($(el).attr("name") || "");
      if (name) form[name] = String($(el).attr("value") || "");
    });
    form.email = email;
    form.pass = password;

    const action = resolveAction(loginForm, "https://www.facebook.com/login/device-based/regular/login/?login_attempt=1&lwv=110");
    logger(chalk.italic(`🔐 Local Facebook login: ${mask(email, 2)}`), "info");

    let response = await post(action, jar, form, opts);
    let body = bodyOf(response);
    let currentUrl = responseUrl(response, action);

    if (await hasUserCookie()) {
      const cookies = await getAppState(jar);
      logger(chalk.italic(`✅ Local Facebook login successful (${Date.now() - started}ms)`), "info");
      return { ok: true, cookies, uid: cookies.find(c => c.key === "c_user" || c.key === "i_user")?.value || null };
    }

    // Facebook can return the approval/checkpoint form directly in the POST
    // response; do not depend on a redirect URL being exposed by Axios.
    if (isApprovalHtml(body) || /checkpoint|login-approval|approvals_code/i.test(currentUrl)) {
      const handled = await submitApproval(body, currentUrl);
      if (await hasUserCookie()) {
        const cookies = await getAppState(jar);
        logger(chalk.italic(`✅ Facebook 2FA login successful (${Date.now() - started}ms)`), "info");
        return { ok: true, cookies, uid: cookies.find(c => c.key === "c_user" || c.key === "i_user")?.value || null };
      }
      if (handled?.body) body = handled.body;
      currentUrl = handled?.url || currentUrl;
    }

    // A few Facebook flows expose the challenge only after loading the
    // returned location. Try that location before declaring login failure.
    if (currentUrl && /facebook\.com/i.test(currentUrl) && /checkpoint|login|approval/i.test(currentUrl)) {
      const challenge = await get(currentUrl, jar, null, opts);
      const challengeBody = bodyOf(challenge);
      if (isApprovalHtml(challengeBody)) {
        await submitApproval(challengeBody, responseUrl(challenge, currentUrl));
      }
    }

    if (!await hasUserCookie()) {
      const forms = formInfo(body);
      const formSummary = forms.slice(0, 4).map(f => `${f.action || "?"}[${f.names.slice(0, 8).join(",")}]`).join(" | ");
      const title = String(cheerio.load(body)("title").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const status = response?.status || response?.statusCode || "?";
      const reason = isApprovalHtml(body) ? "verification/challenge returned" : "no authenticated cookie returned";
      throw new Error(`Facebook login failed (${reason}; HTTP ${status}; title="${title}"; url="${currentUrl || "?"}"; forms=${formSummary || "none"})`);
    }

    const cookies = await getAppState(jar);
    logger(chalk.italic(`✅ Local Facebook login successful (${Date.now() - started}ms)`), "info");
    return { ok: true, cookies, uid: cookies.find(c => c.key === "c_user" || c.key === "i_user")?.value || null };
  } catch (error) {
    const msg = error?.message || String(error);
    logger(chalk.italic(`❌ Local Facebook login failed: ${msg}`), "error");
    return { ok: false, message: msg, error: error?.error };
  }
}

async function tokensViaAPI(email, password, twoFactor = null, globalOptions = {}) {
  const res = await loginViaFacebookWeb(email, password, twoFactor, globalOptions);
  return res.ok ? { status: true, cookies: res.cookies, uid: res.uid } : { status: false, message: res.message };
}

function normalizeCookieHeaderString(s) {
  let str = String(s || "").trim();
  if (!str) return [];
  if (/^cookie\s*:/i.test(str)) str = str.replace(/^cookie\s*:/i, "").trim();
  str = str.replace(/\r?\n/g, " ").replace(/\s*;\s*/g, ";");
  const parts = str.split(";").map(v => v.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!k) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

function setJarFromPairs(j, pairs, domain = ".facebook.com") {
  const urls = [
    "https://www.facebook.com",
    "https://m.facebook.com"
  ];
  for (const kv of pairs || []) {
    if (!kv || !String(kv).includes("=")) continue;
    const cookieStr = `${kv}; Domain=${domain}; Path=/; Secure`;
    for (const url of urls) {
      try {
        if (typeof j.setCookieSync === "function") j.setCookieSync(cookieStr, url);
        else if (typeof j.setCookie === "function") awaitMaybeSetCookie(j, cookieStr, url);
      } catch (_) {}
    }
  }
}

function awaitMaybeSetCookie(j, cookieStr, url) {
  try {
    const result = j.setCookie(cookieStr, url);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (_) {}
}

function setJarFromAppState(j, cookies) {
  if (!Array.isArray(cookies)) return 0;
  let count = 0;
  for (const c of cookies) {
    const key = String(c?.key ?? c?.name ?? "").trim();
    const value = String(c?.value ?? "");
    if (!key || !value) continue;
    const domain = c?.domain || ".facebook.com";
    const cookiePath = c?.path || "/";
    const attrs = [`Domain=${domain}`, `Path=${cookiePath}`];
    if (c?.secure !== false) attrs.push("Secure");
    if (c?.httpOnly) attrs.push("HttpOnly");
    if (c?.sameSite) attrs.push(`SameSite=${String(c.sameSite)}`);

    const exp = c?.expirationDate ?? c?.expires;
    if (exp && exp !== "Infinity" && exp !== Infinity) {
      let ms = NaN;
      if (exp instanceof Date) ms = exp.getTime();
      else if (typeof exp === "number") ms = exp < 1e12 ? exp * 1000 : exp;
      else if (typeof exp === "string") ms = new Date(exp).getTime();
      if (Number.isFinite(ms) && ms > 0) attrs.push(`Expires=${new Date(ms).toUTCString()}`);
    }

    const cookieStr = `${key}=${value}; ${attrs.join("; ")}`;
    try {
      if (typeof j.setCookieSync === "function") j.setCookieSync(cookieStr, `https://www.facebook.com${cookiePath}`);
      else if (typeof j.setCookie === "function") j.setCookie(cookieStr, `https://www.facebook.com${cookiePath}`);
      count++;
    } catch (_) {}
  }
  return count;
}


function cookieHeaderFromJar(j) {
  const urls = ["https://www.facebook.com"];
  const seen = new Set();
  const parts = [];
  for (const u of urls) {
    let s = "";
    try {
      s = typeof j.getCookieStringSync === "function" ? j.getCookieStringSync(u) : "";
    } catch { }
    if (!s) continue;
    for (const kv of s.split(";")) {
      const t = kv.trim();
      const name = t.split("=")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      parts.push(t);
    }
  }
  return parts.join("; ");
}

// Legacy SQL-backup hooks are intentionally no-ops.
// SunkenBot persists AppState through its encrypted file/MongoDB layer instead.
async function backupAppStateSQL() { return false; }
async function getLatestBackup() { return null; }
async function getLatestBackupAny() { return null; }


async function setJarCookies(j, appstate) {
  const tasks = [];
  for (const c of appstate) {
    const cookieName = c.name || c.key;
    const cookieValue = c.value;
    if (!cookieName || cookieValue === undefined) continue;

    const cookieDomain = c.domain || ".facebook.com";
    const cookiePath = c.path || "/";
    const dom = cookieDomain.replace(/^\./, "");

    // Handle expirationDate (can be in seconds or milliseconds)
    let expiresStr = "";
    if (c.expirationDate !== undefined) {
      let expiresDate;
      if (typeof c.expirationDate === "number") {
        // If expirationDate is less than a year from now in seconds, treat as seconds
        // Otherwise treat as milliseconds
        const now = Date.now();
        const oneYearInMs = 365 * 24 * 60 * 60 * 1000;
        if (c.expirationDate < (now + oneYearInMs) / 1000) {
          expiresDate = new Date(c.expirationDate * 1000);
        } else {
          expiresDate = new Date(c.expirationDate);
        }
      } else {
        expiresDate = new Date(c.expirationDate);
      }
      expiresStr = `; expires=${expiresDate.toUTCString()}`;
    } else if (c.expires) {
      const expiresDate = typeof c.expires === "number" ? new Date(c.expires) : new Date(c.expires);
      expiresStr = `; expires=${expiresDate.toUTCString()}`;
    }

    // Helper function to build cookie string
    const buildCookieString = (domainOverride = null) => {
      const domain = domainOverride || cookieDomain;
      let cookieParts = [`${cookieName}=${cookieValue}${expiresStr}`];
      cookieParts.push(`Domain=${domain}`);
      cookieParts.push(`Path=${cookiePath}`);

      // Add Secure flag if secure is true
      if (c.secure === true) {
        cookieParts.push("Secure");
      }

      // Add HttpOnly flag if httpOnly is true
      if (c.httpOnly === true) {
        cookieParts.push("HttpOnly");
      }

      // Add SameSite attribute if provided
      if (c.sameSite) {
        const sameSiteValue = String(c.sameSite).toLowerCase();
        if (["strict", "lax", "none"].includes(sameSiteValue)) {
          cookieParts.push(`SameSite=${sameSiteValue.charAt(0).toUpperCase() + sameSiteValue.slice(1)}`);
        }
      }

      return cookieParts.join("; ");
    };
    const cookieConfigs = [];
    if (cookieDomain === ".facebook.com" || cookieDomain === "facebook.com") {
      cookieConfigs.push({ url: `http://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `http://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
    } else {
      cookieConfigs.push({ url: `http://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `http://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
      cookieConfigs.push({ url: `https://www.${dom}${cookiePath}`, cookieStr: buildCookieString() });
    }

    for (const config of cookieConfigs) {
      tasks.push(j.setCookie(config.cookieStr, config.url).catch((err) => {
        if (err && err.message && err.message.includes("Cookie not in this host's domain")) {
          return;
        }
        return;
      }));
    }
  }
  await Promise.all(tasks);
}

async function tokens(username, password, twofactor = null, globalOptions = {}) {
  return tokensViaAPI(username, password, twofactor, globalOptions);
}

async function tokensWithOptions(username, password, twofactor = null, globalOptions = {}) {
  return tokens(username, password, twofactor, globalOptions);
}

async function hydrateJarFromDB() {
  return false;
}


async function tryAutoLoginIfNeeded(currentHtml, currentCookies, globalOptions, ctxRef, hadAppStateInput = false, jar, twofactor = null) {
  // Helper to validate UID - must be a non-zero positive number string
  const isValidUID = uid => uid && uid !== "0" && /^\d+$/.test(uid) && parseInt(uid, 10) > 0;

  const getUID = cs =>
    cs.find(c => c.key === "i_user")?.value ||
    cs.find(c => c.key === "c_user")?.value ||
    cs.find(c => c.name === "i_user")?.value ||
    cs.find(c => c.name === "c_user")?.value;
  const htmlUID = body => {
    const s = typeof body === "string" ? body : String(body ?? "");
    return s.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s.match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
  };

  let userID = getUID(currentCookies);
  // Also try to extract userID from HTML if cookie userID is invalid
  if (!isValidUID(userID)) {
    userID = htmlUID(currentHtml);
  }
  // If we have a valid userID, return success
  if (isValidUID(userID)) {
    return { html: currentHtml, cookies: currentCookies, userID };
  }

  // No valid userID found - need to try auto-login
  logger("tryAutoLoginIfNeeded: No valid userID found, attempting recovery...", "warn");

  // If appState/Cookie was provided and is not checkpointed, try refresh
  if (hadAppStateInput) {
    const isCheckpoint = currentHtml.includes("/checkpoint/block/?next");
    if (!isCheckpoint) {
      try {
        const refreshedCookies = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
        userID = getUID(refreshedCookies);
        if (isValidUID(userID)) {
          return { html: currentHtml, cookies: refreshedCookies, userID };
        }
      } catch { }
    }
  }

  // Try to hydrate from DB backup
  const hydrated = await hydrateJarFromDB(null, jar);
  if (hydrated) {
    logger("tryAutoLoginIfNeeded: Trying backup from DB...", "info");
    try {
      const initial = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
      const resB = (await ctxRef.bypassAutomation(initial, jar)) || initial;
      const htmlB = resB && resB.data ? resB.data : "";
      if (!htmlB.includes("/checkpoint/block/?next")) {
        const htmlUserID = htmlUID(htmlB);
        if (isValidUID(htmlUserID)) {
          const cookiesB = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
          logger(`tryAutoLoginIfNeeded: DB backup session valid, USER_ID=${htmlUserID}`, "info");
          return { html: htmlB, cookies: cookiesB, userID: htmlUserID };
        } else {
          logger(`tryAutoLoginIfNeeded: DB backup session dead (HTML USER_ID=${htmlUserID || "empty"}), will try local credential login...`, "warn");
        }
      }
    } catch (dbErr) {
      logger(`tryAutoLoginIfNeeded: DB backup failed - ${dbErr && dbErr.message ? dbErr.message : String(dbErr)}`, "warn");
    }
  }

  // Check if auto-login is enabled (support both true and "true")
  if (config.autoLogin === false || config.autoLogin === "false") {
    throw new Error("AppState expired — Auto-login is disabled");
  }

  // Try local credential login
  const u = config.credentials?.email || config.email;
  const p = config.credentials?.password || config.password;
  const tf = twofactor || config.credentials?.twofactor || config.twofactor || null;

  if (!u || !p) {
    logger("tryAutoLoginIfNeeded: No credentials configured for auto-login!", "error");
    throw new Error("Missing credentials for auto-login (email/password not configured in fca-config.json)");
  }

  logger(`tryAutoLoginIfNeeded: Attempting local credential login for ${u.slice(0, 3)}***...`, "info");

  const r = await tokensWithOptions(u, p, tf, globalOptions);
  if (!r || !r.status) {
    throw new Error(r && r.message ? r.message : "credential login failed");
  }

  logger(`tryAutoLoginIfNeeded: Local credential login successful! UID: ${r.uid}`, "info");

  // Handle cookies - can be array, cookie string header, or both
  let cookiePairs = [];
  
  // If cookies is a string (cookie header format), parse it
  if (typeof r.cookies === "string") {
    cookiePairs = normalizeCookieHeaderString(r.cookies);
  } 
  // If cookies is an array, convert to pairs
  else if (Array.isArray(r.cookies)) {
    cookiePairs = r.cookies.map(c => {
      if (typeof c === "string") {
        // Already in "key=value" format
        return c;
      } else if (c && typeof c === "object") {
        // Object format {key, value} or {name, value}
        return `${c.key || c.name}=${c.value}`;
      }
      return null;
    }).filter(Boolean);
  }
  
  // Also check for cookie field (alternative field name)
  if (cookiePairs.length === 0 && r.cookie) {
    if (typeof r.cookie === "string") {
      cookiePairs = normalizeCookieHeaderString(r.cookie);
    } else if (Array.isArray(r.cookie)) {
      cookiePairs = r.cookie.map(c => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") return `${c.key || c.name}=${c.value}`;
        return null;
      }).filter(Boolean);
    }
  }

  if (cookiePairs.length === 0) {
    logger("tryAutoLoginIfNeeded: No cookies found in login response", "warn");
    throw new Error("API login returned no cookies");
  } else {
    logger(`tryAutoLoginIfNeeded: Parsed ${cookiePairs.length} cookies from login response`, "info");
    if (Array.isArray(r.cookies)) {
      setJarFromAppState(jar, r.cookies);
    } else {
      setJarFromPairs(jar, cookiePairs, ".facebook.com");
    }
  }

  // Wait a bit for cookies to be set
  await new Promise(resolve => setTimeout(resolve, 500));

  // Refresh Facebook page with new cookies - try multiple times if needed
  // Try both www.facebook.com and m.facebook.com to ensure session is established
  let html2 = "";
  let res2 = null;
  let retryCount = 0;
  const maxRetries = 3;
  const urlsToTry = ["https://m.facebook.com/", "https://www.facebook.com/"];

  while (retryCount < maxRetries) {
    try {
      // Try m.facebook.com first (mobile version often works better for API login)
      const urlToUse = retryCount === 0 ? urlsToTry[0] : urlsToTry[retryCount % urlsToTry.length];
      logger(`tryAutoLoginIfNeeded: Refreshing ${urlToUse} (attempt ${retryCount + 1}/${maxRetries})...`, "info");
      
      const initial2 = await get(urlToUse, jar, null, globalOptions).then(saveCookies(jar));
      res2 = (await ctxRef.bypassAutomation(initial2, jar)) || initial2;
      html2 = res2 && res2.data ? res2.data : "";

      if (html2.includes("/checkpoint/block/?next")) {
        throw new Error("Checkpoint after API login");
      }

      // Check if HTML contains valid USER_ID
      const htmlUserID = htmlUID(html2);
      if (isValidUID(htmlUserID)) {
        logger(`tryAutoLoginIfNeeded: Found valid USER_ID in HTML from ${urlToUse}: ${htmlUserID}`, "info");
        break;
      }

      // If no valid USER_ID found, wait and retry with different URL
      if (retryCount < maxRetries - 1) {
        logger(`tryAutoLoginIfNeeded: No valid USER_ID in HTML from ${urlToUse} (attempt ${retryCount + 1}/${maxRetries}), retrying...`, "warn");
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        retryCount++;
      } else {
        logger("tryAutoLoginIfNeeded: No valid USER_ID found in HTML after retries", "warn");
        break;
      }
    } catch (err) {
      if (err.message && err.message.includes("Checkpoint")) {
        throw err;
      }
      if (retryCount < maxRetries - 1) {
        logger(`tryAutoLoginIfNeeded: Error refreshing page (attempt ${retryCount + 1}/${maxRetries}): ${err && err.message ? err.message : String(err)}`, "warn");
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        retryCount++;
      } else {
        throw err;
      }
    }
  }

  const cookies2 = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
  const uid2 = getUID(cookies2);
  const htmlUserID2 = htmlUID(html2);

  // Prioritize USER_ID from HTML over cookies (more reliable)
  let finalUID = null;
  if (isValidUID(htmlUserID2)) {
    finalUID = htmlUserID2;
    logger(`tryAutoLoginIfNeeded: Using USER_ID from HTML: ${finalUID}`, "info");
  } else if (isValidUID(uid2)) {
    finalUID = uid2;
    logger(`tryAutoLoginIfNeeded: Using USER_ID from cookies: ${finalUID}`, "info");
  } else if (isValidUID(r.uid)) {
    finalUID = r.uid;
    logger(`tryAutoLoginIfNeeded: Using USER_ID from login response: ${finalUID}`, "info");
  }

  if (!isValidUID(finalUID)) {
    logger(`tryAutoLoginIfNeeded: HTML check - USER_ID from HTML: ${htmlUserID2 || "none"}, from cookies: ${uid2 || "none"}, from API: ${r.uid || "none"}`, "error");
    throw new Error("Login failed - could not get valid userID after API login. HTML may indicate session is not established.");
  }

  // Final validation: ensure HTML shows we're logged in
  if (!isValidUID(htmlUserID2)) {
    logger("tryAutoLoginIfNeeded: WARNING - HTML does not show valid USER_ID, but proceeding with cookie-based UID", "warn");
  }

  return { html: html2, cookies: cookies2, userID: finalUID };
}

function makeLogin(j, email, password, globalOptions, twofactor = null) {
  return async function () {
    const u = email || config.credentials?.email;
    const p = password || config.credentials?.password;
    const tf = twofactor || config.credentials?.twofactor || config.twofactor || null;
    if (!u || !p) return;
    const r = await tokensWithOptions(u, p, tf, globalOptions);
    if (r && r.status && Array.isArray(r.cookies)) {
      setJarFromAppState(j, r.cookies);
      await get("https://www.facebook.com/", j, null, globalOptions).then(saveCookies(j));
    } else {
      throw new Error(r && r.message ? r.message : "Login failed");
    }
  };
}

function loginHelper(appState, Cookie, email, password, globalOptions, callback, prCallback, twofactor = null) {
  try {
    // Each call to loginHelper() (i.e. each login()/account) gets its own,
    // isolated CookieJar instead of sharing one process-wide singleton.
    // Previously this file imported a single module-level `jar` shared by
    // every account logged in within the same Node process; logging in a
    // second account would silently overwrite/merge cookies with the first
    // account's session (c_user/xs swapping mid-session), which is exactly
    // the kind of implementation bug that produces "abnormal session" /
    // forced logout on Facebook's side. Session isolation now lives here.
    const jar = new CookieJar();
    const domain = ".facebook.com";
    // Helper to extract userID from appState input
    const extractUIDFromAppState = (appStateInput) => {
      if (!appStateInput) return null;
      let parsed = appStateInput;
      if (typeof appStateInput === "string") {
        try {
          parsed = JSON.parse(appStateInput);
        } catch {
          return null;
        }
      }
      if (Array.isArray(parsed)) {
        const cUser = parsed.find(c => (c.key === "c_user" || c.name === "c_user"));
        if (cUser) return cUser.value;
        const iUser = parsed.find(c => (c.key === "i_user" || c.name === "i_user"));
        if (iUser) return iUser.value;
      }
      return null;
    };
    let userIDFromAppState = extractUIDFromAppState(appState);
    (async () => {
      try {
        if (appState) {
          // Check and convert cookie to appState format
          if (Array.isArray(appState) && appState.some(c => c.name)) {
            // Convert name to key if needed
            appState = appState.map(c => {
              if (c.name && !c.key) {
                c.key = c.name;
                delete c.name;
              }
              return c;
            });
          } else if (typeof appState === "string") {
            // Try to parse as JSON first
            let parsed = appState;
            try {
              parsed = JSON.parse(appState);
            } catch { }

            if (Array.isArray(parsed)) {
              // Already parsed as array, use it
              appState = parsed;
            } else {
              // Parse string cookie format (key=value; key2=value2)
              const arrayAppState = [];
              appState.split(';').forEach(c => {
                const [key, value] = c.split('=');
                if (key && value) {
                  arrayAppState.push({
                    key: key.trim(),
                    value: value.trim(),
                    domain: ".facebook.com",
                    path: "/",
                  });
                }
              });
              appState = arrayAppState;
            }
          }

          // Set cookies into jar with individual domain/path
          if (Array.isArray(appState)) {
            await setJarCookies(jar, appState);
          } else {
            throw new Error("Invalid appState format");
          }
        }
        if (Cookie) {
          let cookiePairs = [];
          if (typeof Cookie === "string") cookiePairs = normalizeCookieHeaderString(Cookie);
          else if (Array.isArray(Cookie)) cookiePairs = Cookie.map(String).filter(Boolean);
          else if (Cookie && typeof Cookie === "object") cookiePairs = Object.entries(Cookie).map(([k, v]) => `${k}=${v}`);
          if (cookiePairs.length) setJarFromPairs(jar, cookiePairs, domain);
        }
      } catch (e) {
        return callback(e);
      }
      const ctx = { globalOptions, options: globalOptions, reconnectAttempts: 0 };
      ctx.bypassAutomation = async function (resp, j) {
        global.fca = global.fca || {};
        global.fca.BypassAutomationNotification = this.bypassAutomation.bind(this);
        const s = x => (typeof x === "string" ? x : String(x ?? ""));
        const u = r => r?.request?.res?.responseUrl || (r?.config?.baseURL ? new URL(r.config.url || "/", r.config.baseURL).toString() : r?.config?.url || "");
        const isCp = r => typeof u(r) === "string" && u(r).includes("checkpoint/601051028565049");
        const cookieUID = async () => {
          try {
            const cookies = typeof j?.getCookies === "function" ? await j.getCookies("https://www.facebook.com") : [];
            return cookies.find(c => c.key === "i_user")?.value || cookies.find(c => c.key === "c_user")?.value;
          } catch { return undefined; }
        };
        const htmlUID = body => s(body).match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s(body).match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
        const getUID = async body => (await cookieUID()) || htmlUID(body);
        const refreshJar = async () => get("https://www.facebook.com/", j, null, this.options).then(saveCookies(j));
        const bypass = async body => {
          const b = s(body);
          const UID = await getUID(b);
          const fb_dtsg = getFrom(b, '"DTSGInitData",[],{"token":"', '",') || b.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1];
          const jazoest = getFrom(b, 'name="jazoest" value="', '"') || getFrom(b, "jazoest=", '",') || b.match(/name="jazoest"\s+value="([^"]+)"/)?.[1];
          const lsd = getFrom(b, '["LSD",[],{"token":"', '"}') || b.match(/name="lsd"\s+value="([^"]+)"/)?.[1];
          const form = { av: UID, fb_dtsg, jazoest, lsd, fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "FBScrapingWarningMutation", variables: "{}", server_timestamps: true, doc_id: 6339492849481770 };
          await post("https://www.facebook.com/api/graphql/", j, form, null, this.options).then(saveCookies(j));
          logger("⚠️ Facebook automation detected — bypassing...", "warn");
          this.reconnectAttempts = 0;
        };
        try {
          if (resp) {
            if (isCp(resp)) {
              await bypass(s(resp.data));
              const refreshed = await refreshJar();
              if (isCp(refreshed)) logger("Checkpoint still present after refresh", "warn");
              else logger("✅ Bypass complete — session restored.", "info");
              return refreshed;
            }
            return resp;
          }
          const first = await get("https://www.facebook.com/", j, null, this.options).then(saveCookies(j));
          if (isCp(first)) {
            await bypass(s(first.data));
            const refreshed = await refreshJar();
            if (!isCp(refreshed)) logger("✅ Bypass complete — session restored.", "info");
            else logger("Checkpoint still present after refresh", "warn");
            return refreshed;
          }
          return first;
        } catch (e) {
          logger(`Bypass automation error: ${e && e.message ? e.message : String(e)}`, "error");
          return resp;
        }
      };
      if (appState || Cookie) {
        const initial = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
        return (await ctx.bypassAutomation(initial, jar)) || initial;
      }
      const hydrated = await hydrateJarFromDB(null, jar);
      if (hydrated) {
        logger(chalk.italic("🔄 AppState backup found — restoring session..."), "info");
        const initial = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
        return (await ctx.bypassAutomation(initial, jar)) || initial;
      }
      logger(chalk.italic("😐 AppState expired — logging in with credentials..."), "warn");
      return get("https://www.facebook.com/", null, null, globalOptions)
        .then(saveCookies(jar))
        .then(makeLogin(jar, email, password, globalOptions, twofactor))
        .then(function () {
          return get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
        });
    })()
      .then(async function (res) {
        const ctx = {};
        ctx.options = globalOptions;
        ctx.bypassAutomation = async function (resp, j) {
          global.fca = global.fca || {};
          global.fca.BypassAutomationNotification = this.bypassAutomation.bind(this);
          const s = x => (typeof x === "string" ? x : String(x ?? ""));
          const u = r => r?.request?.res?.responseUrl || (r?.config?.baseURL ? new URL(r.config.url || "/", r.config.baseURL).toString() : r?.config?.url || "");
          const isCp = r => typeof u(r) === "string" && u(r).includes("checkpoint/601051028565049");
          const cookieUID = async () => {
            try {
              const cookies = typeof j?.getCookies === "function" ? await j.getCookies("https://www.facebook.com") : [];
              return cookies.find(c => c.key === "i_user")?.value || cookies.find(c => c.key === "c_user")?.value;
            } catch { return undefined; }
          };
          const htmlUID = body => s(body).match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s(body).match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
          const getUID = async body => (await cookieUID()) || htmlUID(body);
          const refreshJar = async () => get("https://www.facebook.com/", j, null, this.options).then(saveCookies(j));
          const bypass = async body => {
            const b = s(body);
            const UID = await getUID(b);
            const fb_dtsg = getFrom(b, '"DTSGInitData",[],{"token":"', '",') || b.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1];
            const jazoest = getFrom(b, 'name="jazoest" value="', '"') || getFrom(b, "jazoest=", '",') || b.match(/name="jazoest"\s+value="([^"]+)"/)?.[1];
            const lsd = getFrom(b, '["LSD",[],{"token":"', '"}') || b.match(/name="lsd"\s+value="([^"]+)"/)?.[1];
            const form = { av: UID, fb_dtsg, jazoest, lsd, fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "FBScrapingWarningMutation", variables: "{}", server_timestamps: true, doc_id: 6339492849481770 };
            await post("https://www.facebook.com/api/graphql/", j, form, null, this.options).then(saveCookies(j));
            logger("⚠️ Facebook automation detected — bypassing...", "warn");
          };
          try {
            if (res && isCp(res)) {
              await bypass(s(res.data));
              const refreshed = await refreshJar();
              if (!isCp(refreshed)) logger("✅ Bypass complete — session restored.", "info");
              return refreshed;
            }
            logger("✅ No checkpoint detected — session is clean.", "info");
            return res;
          } catch {
            return res;
          }
        };
        const processed = (await ctx.bypassAutomation(res, jar)) || res;
        let html = processed && processed.data ? processed.data : "";
        let cookies = await Promise.resolve(jar.getCookies("https://www.facebook.com"));
        const getUIDFromCookies = cs =>
          cs.find(c => c.key === "i_user")?.value ||
          cs.find(c => c.key === "c_user")?.value ||
          cs.find(c => c.name === "i_user")?.value ||
          cs.find(c => c.name === "c_user")?.value;
        const getUIDFromHTML = body => {
          const s = typeof body === "string" ? body : String(body ?? "");
          return s.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1] || s.match(/\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/)?.[1];
        };
        // Helper to validate UID - must be a non-zero positive number string
        const isValidUID = uid => uid && uid !== "0" && /^\d+$/.test(uid) && parseInt(uid, 10) > 0;

        let userID = getUIDFromCookies(cookies);
        // Also try to extract userID from HTML if not found in cookies
        if (!isValidUID(userID)) {
          userID = getUIDFromHTML(html);
        }
        // If still not found and appState was provided, use userID from appState input as fallback
        if (!isValidUID(userID) && userIDFromAppState && isValidUID(userIDFromAppState)) {
          userID = userIDFromAppState;
        }
        // Trigger auto-login if userID is invalid (missing or "0")
        if (!isValidUID(userID)) {
          logger("Invalid userID detected (missing or 0), attempting auto-login...", "warn");
          // Pass hadAppStateInput=true if appState/Cookie was originally provided
          const retried = await tryAutoLoginIfNeeded(html, cookies, globalOptions, ctx, !!(appState || Cookie), jar, twofactor);
          html = retried.html;
          cookies = retried.cookies;
          userID = retried.userID;
          
          // Validate HTML after auto-login - ensure it contains valid USER_ID
          const htmlUserIDAfterLogin = getUIDFromHTML(html);
          if (!isValidUID(htmlUserIDAfterLogin)) {
            logger("After auto-login, HTML still does not contain valid USER_ID. Session may not be established.", "error");
            // Try one more refresh
            try {
              const refreshRes = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
              const refreshedHtml = refreshRes && refreshRes.data ? refreshRes.data : "";
              const refreshedHtmlUID = getUIDFromHTML(refreshedHtml);
              if (isValidUID(refreshedHtmlUID)) {
                html = refreshedHtml;
                userID = refreshedHtmlUID;
                logger(`After refresh, found valid USER_ID in HTML: ${userID}`, "info");
              } else {
                throw new Error("Login failed - HTML does not show valid USER_ID after auto-login and refresh");
              }
            } catch (refreshErr) {
              throw new Error(`Login failed - Could not establish valid session. HTML USER_ID check failed: ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`);
            }
          } else {
            // Use USER_ID from HTML as it's more reliable
            userID = htmlUserIDAfterLogin;
            logger(`After auto-login, using USER_ID from HTML: ${userID}`, "info");
          }
        }
        if (html.includes("/checkpoint/block/?next")) {
          logger(chalk.italic("😿 Session expired! Please update your appstate."), "error");
          throw new Error("Checkpoint");
        }
        
        // Final validation: ensure HTML shows we're logged in before proceeding
        let finalHtmlUID = getUIDFromHTML(html);
        if (!isValidUID(finalHtmlUID)) {
          // If cookies have valid UID but HTML doesn't, try to "activate" session
          if (isValidUID(userID)) {
            logger(`HTML shows USER_ID=${finalHtmlUID || "none"} but cookies have valid UID=${userID}. Attempting to activate session...`, "warn");
            
            // Try making requests to activate the session
            try {
              // Wait a bit first for cookies to propagate
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              // Try refreshing with m.facebook.com/home.php (mobile home page)
              logger("Trying to activate session via m.facebook.com/home.php...", "info");
              const activateRes = await get("https://m.facebook.com/home.php", jar, null, globalOptions).then(saveCookies(jar));
              const activateHtml = activateRes && activateRes.data ? activateRes.data : "";
              const activateUID = getUIDFromHTML(activateHtml);
              
              if (isValidUID(activateUID)) {
                html = activateHtml;
                finalHtmlUID = activateUID;
                userID = activateUID;
                logger(`Session activated! Found valid USER_ID in HTML: ${userID}`, "info");
              } else {
                // Try one more time with www.facebook.com/home.php after delay
                await new Promise(resolve => setTimeout(resolve, 1500));
                logger("Trying to activate session via www.facebook.com/home.php...", "info");
                const activateRes2 = await get("https://www.facebook.com/home.php", jar, null, globalOptions).then(saveCookies(jar));
                const activateHtml2 = activateRes2 && activateRes2.data ? activateRes2.data : "";
                const activateUID2 = getUIDFromHTML(activateHtml2);
                
                if (isValidUID(activateUID2)) {
                  html = activateHtml2;
                  finalHtmlUID = activateUID2;
                  userID = activateUID2;
                  logger(`Session activated on second try! Found valid USER_ID in HTML: ${userID}`, "info");
                } else {
                  // If cookies have valid UID, we can proceed with cookie-based UID but warn
                  logger(`WARNING: HTML still shows USER_ID=${finalHtmlUID || "none"} but cookies have valid UID=${userID}. Proceeding with cookie-based UID.`, "warn");
                  // Don't throw error, proceed with cookie-based UID
                }
              }
            } catch (activateErr) {
              logger(`Failed to activate session: ${activateErr && activateErr.message ? activateErr.message : String(activateErr)}. Proceeding with cookie-based UID.`, "warn");
              // Don't throw error, proceed with cookie-based UID
            }
          } else {
            // No valid UID in either cookies or HTML
            logger(`Final HTML validation failed - USER_ID from HTML: ${finalHtmlUID || "none"}, from cookies: ${userID || "none"}`, "error");
            throw new Error("Login validation failed - HTML does not contain valid USER_ID. Session may not be properly established.");
          }
        }
        
        // Final check: ensure we have a valid userID (either from HTML or cookies)
        if (!isValidUID(userID)) {
          logger(`No valid USER_ID found - HTML: ${finalHtmlUID || "none"}, Cookies: ${userID || "none"}`, "error");
          throw new Error("Login validation failed - No valid USER_ID found in HTML or cookies.");
        }
        let mqttEndpoint;
        let region = "PRN";
        let fb_dtsg;
        let irisSeqID;
        try {
          const m1 = html.match(/"endpoint":"([^"]+)"/);
          const m2 = m1 ? null : html.match(/endpoint\\":\\"([^\\"]+)\\"/);
          const raw = (m1 && m1[1]) || (m2 && m2[1]);
          if (raw) mqttEndpoint = raw.replace(/\\\//g, "/");
          region = parseRegion(html);
          const rinfo = REGION_MAP.get(region);
          if (rinfo) logger(`Server region ${region} - ${rinfo.name}`, "info");
          else logger(`Server region ${region}`, "info");
        } catch {
          logger("Not MQTT endpoint", "warn");
        }
        try {
          const userDataMatch = String(html).match(/\["CurrentUserInitialData",\[\],({.*?}),\d+\]/);
          if (userDataMatch) {
            const info = JSON.parse(userDataMatch[1]);
            logger(`✅ Logged in as: ${info.NAME} (${info.USER_ID})`, "info");

            // Check if Facebook response shows USER_ID = 0 (session dead)
            if (!isValidUID(info.USER_ID)) {
              logger("Facebook response shows invalid USER_ID (0 or empty), session is dead!", "warn");
              // Force trigger auto-login
              const retried = await tryAutoLoginIfNeeded(html, cookies, globalOptions, ctx, !!(appState || Cookie), jar, twofactor);
              html = retried.html;
              cookies = retried.cookies;
              userID = retried.userID;
              // Re-check after auto-login
              if (!isValidUID(userID)) {
                throw new Error("Auto-login failed - could not get valid userID");
              }
            }
          } else if (userID) {
            logger(`ID người dùng: ${userID}`, "info");
          }
        } catch (userDataErr) {
          // If error is from our validation, rethrow it
          if (userDataErr && userDataErr.message && userDataErr.message.includes("Auto-login failed")) {
            throw userDataErr;
          }
          // Otherwise ignore parsing errors
        }
        const tokenMatch = html.match(/DTSGInitialData.*?token":"(.*?)"/);
        if (tokenMatch) fb_dtsg = tokenMatch[1];
        try {
          if (userID) await backupAppStateSQL(jar, userID);
        } catch { }


        const emitter = new EventEmitter();
        const ctxMain = {
          userID,
          jar,
          globalOptions,
          loggedIn: true,
          access_token: "NONE",
          clientMutationId: 0,
          mqttClient: undefined,
          lastSeqId: irisSeqID,
          syncToken: undefined,
          mqttEndpoint,
          region,
          firstListen: true,
          fb_dtsg,
          clientID: ((Math.random() * 2147483648) | 0).toString(16),
          clientId: getFrom(html, '["MqttWebDeviceID",[],{"clientID":"', '"}') || "",
          wsReqNumber: 0,
          wsTaskNumber: 0,
          tasks: new Map(),
          _emitter: emitter
        };
        ctxMain.options = globalOptions;
        ctxMain.bypassAutomation = ctx.bypassAutomation.bind(ctxMain);
        ctxMain.performAutoLogin = async () => {
          try {
            // still usable. A checkpoint/redirect seen on one request
            // doesn't always mean the whole session is dead (transient FB
            // blips, rate limiting, etc). Cookie/appstate-only logins have
            // no email+password to re-login with, so without this check a
            // single false-positive checkpoint would permanently tear down
            // the bot (via emitAuth) and force a brand new cookie every
            // time instead of just continuing on the still-good session.
            try {
              // hiccup during THIS check alone used to be treated the same
              // as a dead session and fall through to requiring credentials.
              let stillCheckpointed = true;
              let uid = null;
              for (let attempt = 0; attempt < 3 && !uid; attempt++) {
                try {
                  const check = await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
                  const html = check && check.data ? String(check.data) : "";
                  stillCheckpointed = html.includes("/checkpoint/block/?next") || html.includes("XCheckpointFBScrapingWarningController");
                  const uidMatch = html.match(/"USER_ID"\s*:\s*"(\d+)"/);
                  if (!stillCheckpointed && uidMatch && uidMatch[1] && uidMatch[1] !== "0") {
                    uid = uidMatch[1];
                    break;
                  }
                } catch {
                  // network hiccup on this attempt - retry below instead of
                  // immediately assuming the session is dead
                }
                if (!uid && attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
              }
              if (uid) {
                logger("performAutoLogin: existing cookie session is still valid, continuing without re-login", "info");
                return true;
              }
            } catch {
              // Self-check failed (network hiccup, etc) - fall through to credential-based login below.
            }

            const u = config.credentials?.email || email;
            const p = config.credentials?.password || password;
            const tf = twofactor || config.credentials?.twofactor || config.twofactor || null;
            if (!u || !p) return false;
            const r = await tokensWithOptions(u, p, tf, globalOptions);
            if (!(r && r.status && Array.isArray(r.cookies))) return false;
            setJarFromAppState(jar, r.cookies);
            await get("https://www.facebook.com/", jar, null, globalOptions).then(saveCookies(jar));
            return true;
          } catch {
            return false;
          }
        };
        const api = {
          setOptions: require("./options").setOptions.bind(null, globalOptions),
          getCookies: function () {
            return cookieHeaderFromJar(jar);
          },
          getAppState: function () {
            return getAppState(jar);
          },
          getLatestAppStateFromDB: async function () { return null; },
          getLatestCookieFromDB: async function () { return null; },
          on: emitter.on.bind(emitter),
          once: emitter.once.bind(emitter),
          off: emitter.removeListener.bind(emitter),
          removeAllListeners: emitter.removeAllListeners.bind(emitter)
        };
        const defaultFuncs = makeDefaults(html, userID, ctxMain);
        api.__ctx = ctxMain;
        api.__defaultFuncs = defaultFuncs;

        // Attach lightweight DB updaters for realtime events (MQTT)
        try {
          const Thread = models && models.Thread;
          if (!Thread) {
            throw new Error("Thread model not available");
          }

          ctxMain._updateThreadFromMessage = async msg => {
            try {
              if (!msg || !msg.threadID) return;
              const id = String(msg.threadID);
              // Fast path: increment messageCount column directly
              let affected = 0;
              try {
                const res = await Thread.increment("messageCount", { by: 1, where: { threadID: id } });
                if (Array.isArray(res) && typeof res[0] === "number") {
                  affected = res[0];
                }
              } catch {
                // Ignore increment errors, we'll try to create below
              }
              // If no row was updated, ensure a row exists
              if (!affected) {
                try {
                  await Thread.create({ threadID: id, messageCount: 1, data: { threadID: id } });
                } catch {
                  // Ignore create races / duplicates
                }
              }
            } catch (e) {
              const msgText = e && e.message ? e.message : String(e);
              logger(`updateThreadFromMessage error: ${msgText}`, "warn");
            }
          };
        } catch {
          // If DB layer is unavailable, skip realtime thread updates
        }

        const srcRoot = path.join(__dirname, "../src/api");
        let loaded = 0;
        let skipped = 0;
        fs.readdirSync(srcRoot, { withFileTypes: true }).forEach((sub) => {
          if (!sub.isDirectory()) return;
          const subDir = path.join(srcRoot, sub.name);
          fs.readdirSync(subDir, { withFileTypes: true }).forEach((entry) => {
            if (!entry.isFile() || !entry.name.endsWith(".js")) return;
            const p = path.join(subDir, entry.name);
            const key = path.basename(entry.name, ".js");
            if (api[key]) {
              skipped++;
              return;
            }
            let mod;
            try {
              mod = require(p);
            } catch (e) {
              logger(`Failed to require API module ${p}: ${e && e.message ? e.message : String(e)}`, "warn");
              skipped++;
              return;
            }
            const factory = typeof mod === "function" ? mod : (mod && typeof mod.default === "function" ? mod.default : null);
            if (!factory) {
              logger(`API module ${p} does not export a function, skipping`, "warn");
              skipped++;
              return;
            }
            api[key] = factory(defaultFuncs, api, ctxMain);
            loaded++;
          });
        });
        logger(`Loaded ${loaded} FCA API methods${skipped ? `, skipped ${skipped} duplicates` : ""}`);
        if (api.listenMqtt) {
          api._listenMqttRaw = api.listenMqtt;
          api.listen = api.listenMqtt;
        }
        if (api.refreshFb_dtsg) {
          setInterval(function () {
            api.refreshFb_dtsg().then(function () {
              logger("Successfully refreshed fb_dtsg");
            }).catch(function () {
              logger("An error occurred while refreshing fb_dtsg", "error");
            });
          }, 86400000);
        }
        try {
          api.sessionGuard = require("../src/api/messaging/sessionGuard")(defaultFuncs, api, ctxMain);
        } catch (e) {
          logger(`sessionGuard init failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        try {
          api.sendBroadcast = require("../src/api/messaging/sendBroadcast")(defaultFuncs, api, ctxMain);
        } catch (e) {
          logger(`sendBroadcast init failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        // sendMessage override
        try {
          const fcanxSendMsg = require("../src/api/socket/sendMessage")(defaultFuncs, api, ctxMain);
          api.sendMessage = fcanxSendMsg;
          api.sendMessageMqtt = require("../src/api/socket/sendMessageMqtt")(defaultFuncs, api, ctxMain);
          api.OldMessage = require("../src/api/socket/OldMessage")(defaultFuncs, api, ctxMain);
          api.sendMessageDM = (msg, threadID, cb, replyTo) => api.OldMessage(msg, threadID, cb, replyTo, true);
        } catch (e) {
          logger(`sendMessage override failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        // listenMqtt override
        try {
          api.listenMqtt = require("../src/api/socket/listenMqtt")(defaultFuncs, api, ctxMain);
          api.listen = api.listenMqtt;
        } catch (e) {
          logger(`listenMqtt override failed (non-fatal): ${e && e.message ? e.message : String(e)}`, "warn");
        }

        callback(null, api);
      })
      .catch(function (e) {
        callback(e);
      });
  } catch (e) {
    callback(e);
  }
}

module.exports = loginHelper;
module.exports.loginHelper = loginHelper;
module.exports.tokensViaAPI = tokensViaAPI;
module.exports.loginViaAPI = loginViaFacebookWeb;
module.exports.tokens = tokens;
module.exports.normalizeCookieHeaderString = normalizeCookieHeaderString;
module.exports.setJarFromPairs = setJarFromPairs;
module.exports.setJarFromAppState = setJarFromAppState;
