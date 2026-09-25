"use strict";

const base = require("../../func/logger");

function message(label, msg) {
  return msg === undefined ? label : `${label}: ${msg instanceof Error ? (msg.stack || msg.message) : msg}`;
}

const logger = {
  info(label, msg) { base.info(message(label, msg)); },
  success(label, msg) { base.success(message(label, msg)); },
  warn(label, msg) { base.warn(message(label, msg)); },
  error(label, msg) { base.error(message(label, msg)); },
  debug(label, msg) { base.debug(message(label, msg)); },
  event(label, msg) { base.info(message(label, msg)); },

  banner(name, version, userID, botName, region, autoReconnect) {
    const title = botName ? `${botName} (${userID || "unknown"})` : (userID || "unknown");
    base.success(`${name} v${version} | Bot: ${title} | Region: ${(region || "AUTO").toUpperCase()} | MQTT/WebSocket | Auto-Reconnect: ${autoReconnect ? "on" : "off"}`);
  },

  mqttSpinner: null,
  startSpinner() {},
  stopSpinner() {}
};

module.exports = logger;
module.exports.C = {};
