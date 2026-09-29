import test from "node:test";
import assert from "node:assert/strict";
import { createFirecrawlClient, parseFirecrawlKeys } from "../utils/firecrawlClient.js";

function successResponse(html = "<html></html>") {
  return new Response(JSON.stringify({ success: true, data: { html, metadata: { statusCode: 200 } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("parses comma-separated Firecrawl keys from the documented and legacy environment names", () => {
  assert.deepEqual(parseFirecrawlKeys({
    FIRECRAWL_API: " first-key,second-key ",
    FIRECRUL_API: "second-key,third-key",
  }), ["first-key", "second-key", "third-key"]);
});

test("rotates to the next Firecrawl key after each successful scrape", async () => {
  const authorizationHeaders = [];
  const client = createFirecrawlClient({
    getApiKeys: () => ["key-one", "key-two"],
    fetchImpl: async (_url, options) => {
      authorizationHeaders.push(options.headers.Authorization);
      return successResponse();
    },
  });

  const first = await client.scrape("https://mangalik.net/");
  const second = await client.scrape("https://mangalik.net/");

  assert.equal(first.data.html, "<html></html>");
  assert.equal(second.data.html, "<html></html>");
  assert.deepEqual(authorizationHeaders, ["Bearer key-one", "Bearer key-two"]);
});

test("fails over to the next key when Firecrawl reports a rate limit", async () => {
  const authorizationHeaders = [];
  let calls = 0;
  const client = createFirecrawlClient({
    getApiKeys: () => ["key-one", "key-two"],
    fetchImpl: async (_url, options) => {
      authorizationHeaders.push(options.headers.Authorization);
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      return successResponse("<html>ok</html>");
    },
  });

  const result = await client.scrape("https://mangalik.net/");

  assert.equal(result.data.html, "<html>ok</html>");
  assert.deepEqual(authorizationHeaders, ["Bearer key-one", "Bearer key-two"]);
});

test("reports missing Firecrawl configuration without making a network request", async () => {
  let calls = 0;
  const client = createFirecrawlClient({
    getApiKeys: () => [],
    fetchImpl: async () => { calls++; return successResponse(); },
  });

  await assert.rejects(client.scrape("https://mangalik.net/"), error => error.code === "FIRECRAWL_NOT_CONFIGURED");
  assert.equal(calls, 0);
});
