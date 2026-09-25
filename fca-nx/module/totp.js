"use strict";

let generator = null;
try { generator = require("totp-generator"); } catch { generator = null; }

function normalizeSecret(secret) {
  return String(secret || "").replace(/\s+/g, "").toUpperCase();
}

async function generateTOTP(secret) {
  const value = normalizeSecret(secret);
  if (!value) return null;
  if (!generator) throw new Error("TOTP generator unavailable");

  const fn = typeof generator === "function"
    ? generator
    : generator.TOTP?.generate || generator.generate || null;
  if (typeof fn !== "function") throw new Error("Unsupported totp-generator version");

  const result = await fn(value);
  const code = typeof result === "string" || typeof result === "number"
    ? result
    : result?.otp;
  if (!/^\d{6}$/.test(String(code || ""))) throw new Error("TOTP generator returned an invalid code");
  return String(code);
}

module.exports = { generateTOTP, normalizeSecret };
