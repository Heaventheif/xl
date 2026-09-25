import http from "node:http";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const body = JSON.stringify({
      status: "ok",
      bot: "Sunken Bot",
      uptime: Math.floor((Date.now() - startedAt) / 1000)
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    return res.end(body);
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "not_found" }));
});

server.listen(PORT, HOST, () => {
  global.log?.info?.(`Web server listening on ${HOST}:${PORT}`);
});

server.on("error", error => {
  global.log?.error?.("Web server error", { error: error?.message || String(error) });
});

export default server;
