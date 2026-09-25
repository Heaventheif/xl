import http from "node:http";
import { health as dbHealth } from "./db/index.js";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
const startedAt = Date.now();

function appHealth() {
  const db = dbHealth();
  const api = global.botApi;
  const mqtt = api?.__mqttHealth?.() || api?._mqttManager?.health?.() || null;
  let facebook = false;
  try { facebook = Boolean(api?.getCurrentUserID?.()); } catch (_) {}
  return { database: db.mode === "mongodb" ? "connected" : "degraded", mqtt: mqtt?.ok ? "connected" : (mqtt?.state || "unknown"), facebook: facebook ? "authenticated" : "unknown" };
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const body = JSON.stringify({ status: "ok", bot: "Sunken Bot", uptime: Math.floor((Date.now() - startedAt) / 1000) });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(body);
  }
  if (req.url === "/ready") {
    const checks = appHealth();
    const ready = checks.facebook === "authenticated" && checks.mqtt === "connected" && checks.database !== "degraded";
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({ status: ready ? "ready" : "not_ready", ...checks, uptime: Math.floor((Date.now() - startedAt) / 1000) }));
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "not_found" }));
});
server.listen(PORT, HOST, () => global.log?.info?.(`Web server listening on ${HOST}:${PORT}`));
server.on("error", error => global.log?.error?.("Web server error", { error: error?.message || String(error) }));
export default server;
