"use strict";
/**
 * Fetches MQTT sync sequence ID from GraphQL and starts listenMqtt.
 * Handles retries and auto re-login via fca-config.json when session expires.
 * Fixed by Xalman: Added fb_dtsg/jazoest payload & 1357032 Object error fallback.
 */
const { getType } = require("../../../utils/format");
const { parseAndCheckLogin } = require("../../../utils/client");
const path = require("path");

function getConfig() {
  try {
    const configPath = path.join(process.cwd(), "fca-config.json");
    const fs = require("fs");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch { }
  return {};
}

// Parse cookie string to array format
function parseCookieString(cookieStr) {
  if (!cookieStr || typeof cookieStr !== "string") return [];
  const cookies = [];
  const pairs = cookieStr.split(";").map(p => p.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key && value) {
        cookies.push({
          key,
          value,
          domain: ".facebook.com",
          path: "/"
        });
      }
    }
  }
  return cookies;
}

// Try to auto-login locally using credentials and refresh web session
async function tryAutoLogin() {
  // Credential login is intentionally disabled; recover only through AppState refresh.
  return null;
}

module.exports = function createGetSeqID(deps) {
  const { listenMqtt, logger, emitAuth } = deps;

  return function getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;
    ctx.t_mqttCalled = false;

    // Ensure essential tokens are injected into GraphQL Batch Payload
    if (!form) {
      form = {
        av: ctx.globalOptions.pageID || ctx.userID,
        fb_dtsg: ctx.fb_dtsg,
        jazoest: ctx.jazoest,
        queries: JSON.stringify({
          o0: {
            doc_id: "3336396659757871",
            query_params: {
              limit: 1,
              before: null,
              tags: ["INBOX", "PENDING", "OTHER"],
              includeDeliveryReceipts: false,
              includeSeqID: true
            }
          }
        })
      };
    } else {
      if (!form.fb_dtsg && ctx.fb_dtsg) form.fb_dtsg = ctx.fb_dtsg;
      if (!form.jazoest && ctx.jazoest) form.jazoest = ctx.jazoest;
    }

    return defaultFuncs
      .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(async resData => {
        // Safe check for non-array responses (such as Error Objects from FB)
        if (getType(resData) !== "Array") {
          logger(`getSeqID: Response is not Array, received: ${getType(resData)}`, "warn");

          // Handle Facebook GraphQL 1357032 or transient error responses without triggering re-login
          if (resData && typeof resData === "object") {
            const errCode = resData.error || resData.errorCode;
            const errorMsg = resData.errorSummary || resData.message || "";

            if (errCode === 1357032 || /Something Went Wrong/i.test(errorMsg)) {
              logger("getSeqID: FB returned error 1357032. Using fallback seqID and continuing to MQTT.", "warn");
              ctx.lastSeqId = ctx.lastSeqId || "0";
              listenMqtt(defaultFuncs, api, ctx, globalCallback);
              return;
            }

            if (/Not logged in|login|blocked|401|403|checkpoint/i.test(errorMsg)) {
              throw { error: "Not logged in", originalResponse: resData };
            }
          }

          // Fallback if it's an unrecognized object
          ctx.lastSeqId = ctx.lastSeqId || "0";
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
          return;
        }

        if (!Array.isArray(resData) || !resData.length) return;
        const lastRes = resData[resData.length - 1];
        if (lastRes && lastRes.successful_results === 0) return;

        const syncSeqId = resData[0]?.o0?.data?.viewer?.message_threads?.sync_sequence_id;
        if (syncSeqId) {
          ctx.lastSeqId = syncSeqId;
          logger("mqtt getSeqID ok -> listenMqtt()", "info");
        } else {
          ctx.lastSeqId = ctx.lastSeqId || "0";
          logger("getSeqID: sync_sequence_id not found, fallback lastSeqId=" + ctx.lastSeqId, "warn");
        }
        listenMqtt(defaultFuncs, api, ctx, globalCallback);
      })
      .catch(async err => {
        const detail = (err && err.detail && err.detail.message) ? ` | detail=${err.detail.message}` : "";
        const msg = ((err && err.error) || (err && err.message) || String(err || "")) + detail;

        const isAuthError = /Not logged in|no sync_sequence_id found|blocked the login|401|403/i.test(msg);
        const netCode = err?.code || err?.originalError?.code || "";
        const isNetworkError = !isAuthError && (
          /timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network error|socket hang up/i.test(msg) ||
          /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT/.test(netCode)
        );

        if (isNetworkError) {
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAY * (retryCount + 1);
            logger(`getSeqID: network error, retry ${retryCount + 1}/${MAX_RETRIES} after ${delay}ms... (${msg})`, "warn");
            await new Promise(resolve => setTimeout(resolve, delay));
            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount + 1);
          }
          logger(`getSeqID: network error persisted after ${MAX_RETRIES} retries, giving up for now: ${msg}`, "error");
          // a bare return here made the caller think this call SUCCEEDED.
          const giveUpErr = new Error(`getSeqID network error persisted after ${MAX_RETRIES} retries: ${msg}`);
          giveUpErr.error = msg;
          giveUpErr.isNetworkError = true;
          throw giveUpErr;
        }

        if (isAuthError) {
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAY * (retryCount + 1);
            logger(`getSeqID: retry ${retryCount + 1}/${MAX_RETRIES} after ${delay}ms... (error: ${msg})`, "warn");
            await new Promise(resolve => setTimeout(resolve, delay));
            
            if (retryCount === 0 && ctx.loggedIn) {
              try {
                logger("getSeqID: refreshing session before retry...", "info");
                const { get } = require("../../../utils/request");
                const { saveCookies } = require("../../../utils/client");
                await get("https://www.facebook.com/", ctx.jar, null, ctx.globalOptions, ctx).then(saveCookies(ctx.jar));
              } catch (refreshErr) {
                logger(`getSeqID: session refresh failed: ${refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr)}`, "warn");
              }
            }
            
            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, retryCount + 1);
          }

          logger("getSeqID: all retries failed, attempting auto re-login...", "warn");
          const config = getConfig();
          const loginResult = await tryAutoLogin(logger, config, ctx, defaultFuncs);

          if (loginResult) {
            logger("getSeqID: retrying with new session...", "info");
            await new Promise(resolve => setTimeout(resolve, 3000));
            return getSeqID(defaultFuncs, api, ctx, globalCallback, form, 0);
          }

          if (/blocked/i.test(msg)) {
            return emitAuth(ctx, api, globalCallback, "login_blocked", msg);
          }
          if (/Not logged in/i.test(msg)) {
            return emitAuth(ctx, api, globalCallback, "not_logged_in", msg);
          }
        }

        logger(`getSeqID error: ${msg}`, "error");
        return emitAuth(ctx, api, globalCallback, "auth_error", msg);
      });
  };
};
