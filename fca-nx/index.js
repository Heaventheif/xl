"use strict";

const login = require("./module/login");
const { attachThreadInfoRealtimeSync, applyThreadInfoRealtimeEvent } = require("./src/app/threadInfoRealtimeSync");

module.exports = login;
module.exports.login = login;
module.exports.default = login;
module.exports.attachThreadInfoRealtimeSync = attachThreadInfoRealtimeSync;
module.exports.applyThreadInfoRealtimeEvent = applyThreadInfoRealtimeEvent;
