"use strict";

const { URL } = require("url");
const log = require("../core/logger");

/**
 * Resolve a Facebook profile link to a numeric user ID.
 *
 * Resolution order (nothing leaves your own session unless you opt in):
 *   1. ID already present in the link (profile.php?id=..., or /<digits>)
 *   2. Fetch the profile page with your logged-in session and read the ID from it
 *   3. Only if `allowThirdPartyUID: true` is set in options: external lookup services
 */
module.exports = function (defaultFuncs, api, ctx) {
  function fromLink(u) {
    const id = u.searchParams.get("id");
    if (id && /^\d+$/.test(id)) return id;
    const first = u.pathname.split("/").filter(Boolean)[0];
    if (first && /^\d+$/.test(first)) return first;
    return null;
  }

  async function fromProfilePage(u) {
    const res = await defaultFuncs.get(u.href, ctx.jar, null, ctx.globalOptions);
    const body = String(res && res.body || "");
    const m = body.match(/"(?:userID|entity_id|profile_id|owner_id)":"(\d{5,})"/) ||
              body.match(/fb:\/\/profile\/(\d{5,})/);
    return m ? m[1] : null;
  }

  async function fromThirdParty(u) {
    const axios = require("axios");
    const { data } = await axios.get("https://id.traodoisub.com/api.php", { params: { link: u.href }, timeout: 8000 });
    return data && data.id && /^\d+$/.test(String(data.id)) ? String(data.id) : null;
  }

  async function resolveUID(link) {
    let raw = String(link || "").trim();
    if (!raw) throw new Error("A profile link is required");
    if (!/^https?:\/\//i.test(raw)) raw = "https://www.facebook.com/" + raw.replace(/^\/+/, "");
    const u = new URL(raw);
    if (!/(^|\.)(facebook\.com|fb\.com|fb\.me)$/i.test(u.hostname)) {
      throw new Error("Invalid link. Expected: facebook.com/username");
    }

    let uid = fromLink(u);
    if (uid) return uid;

    try { uid = await fromProfilePage(u); } catch (e) { log.warn("getUID", "Profile lookup failed: " + e.message); }
    if (uid) return uid;

    if (ctx.globalOptions.allowThirdPartyUID === true) {
      uid = await fromThirdParty(u);
      if (uid) return uid;
    }
    throw new Error("Unable to retrieve UID");
  }

  return function getUID(link, callback) {
    const promise = resolveUID(link);
    if (typeof callback === "function") {
      promise.then((uid) => callback(null, uid), (err) => callback(err));
    }
    return promise;
  };
};
