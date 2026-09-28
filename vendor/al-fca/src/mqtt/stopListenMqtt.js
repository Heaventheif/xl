"use strict";

/*
@NethWs3Dev
*/

// @NethWs3Dev
module.exports = function (defaultFuncs, api, ctx){
  return function stopListenMqtt() {
    if (!ctx.mqttClient) {
      throw new Error("Not connected to MQTT");
    }
    ctx._mqttStopped = true;
    if (ctx._clearReconnectTimer) ctx._clearReconnectTimer();
    ctx.mqttClient._alfcaStopped = true;
    ctx.mqttClient.unsubscribe("/webrtc");
    ctx.mqttClient.unsubscribe("/rtc_multi");
    ctx.mqttClient.unsubscribe("/onevc");
    ctx.mqttClient.publish("/browser_close", "{}");
    ctx.mqttClient.end(false, (...data) => {
      ctx.mqttClient = null;
    });
  }
};