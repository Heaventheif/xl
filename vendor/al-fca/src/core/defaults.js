"use strict";

// Single source of truth for the default browser identity. HTTP requests,
// the MQTT websocket and login all use this, so they never contradict each other.
// Override with the `userAgent` option.
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

module.exports = { DEFAULT_USER_AGENT };
