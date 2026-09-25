"use strict";

const chalk = require("chalk");

const LEVELS = {
  info: ["INFO", "cyan"],
  success: ["OK", "green"],
  warn: ["WARN", "yellow"],
  error: ["ERR", "red"],
  debug: ["DEBUG", "gray"]
};

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value ?? "");
}

function normalize(text, type) {
  let level = String(type || "info").toLowerCase();
  if (!LEVELS[level]) level = "info";
  return { level, text: stringify(text).replace(/\r/g, "").replace(/\n+/g, "\n") };
}

function write(text, type = "info") {
  const { level, text: body } = normalize(text, type);
  const [name, color] = LEVELS[level];
  const prefix = chalk.bold(`[FCA:${name}]`);
  const line = `${chalk.gray(timestamp())} ${chalk[color](prefix)} ${body}\n`;
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
}

function logger(text, type) {
  write(text, type);
}

logger.info = (text) => write(text, "info");
logger.success = (text) => write(text, "success");
logger.warn = (text) => write(text, "warn");
logger.error = (text) => write(text, "error");
logger.debug = (text) => write(text, "debug");

module.exports = logger;
