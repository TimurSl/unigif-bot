import assert from "node:assert/strict";
import { test } from "node:test";
import { UnigifClient, UnigifError } from "../src/unigif.js";
import { BASE, fakeUnigif, library } from "./helpers.js";

test("search sends the key, only asks for ready GIFs, and drops ones without an MP4", async () => {
  const s = fakeUnigif(library());
  const page = await s.client.searchGifs({ q: "cat", sort: "used", limit: 10 });
  const req = s.requests.at(-1)!;
  assert.equal(req.auth, "Bearer ugf_test_secret");
  const url = new URL(BASE + req.url);
  assert.equal(url.searchParams.get("status"), "ready");
  assert.equal(url.searchParams.get("sort"), "used");
  assert.equal(url.searchParams.get("q"), "cat");
  assert.ok(page.items.length > 0 && page.items.every((g) => g.media.mp4.url));

  const lib = library();
  lib[0]!.media!.mp4 = null;
  const s2 = fakeUnigif(lib);
  const page2 = await s2.client.searchGifs({ q: "cat funny", sort: "new", limit: 10, exact: true });
  assert.deepEqual(page2.items.map((g) => g.id), []);
});

test("exact search ends the query with a space so the last word is not a prefix", async () => {
  const s = fakeUnigif(library());
  const typing = await s.client.searchGifs({ q: "cat", sort: "new", limit: 50 });
  assert.ok(typing.items.some((g) => g.tags.includes("catnap")), "prefix match finds catnap");
  const exact = await s.client.searchGifs({ q: "cat", sort: "new", limit: 50, exact: true });
  assert.ok(!exact.items.some((g) => g.tags.includes("catnap")), "exact does not");
});

test("an empty query sends no q at all", async () => {
  const s = fakeUnigif(library());
  await s.client.searchGifs({ q: "", sort: "used", limit: 5 });
  assert.equal(new URL(BASE + s.requests.at(-1)!.url).searchParams.has("q"), false);
});

test("errors carry the status, the API's code and Retry-After", async () => {
  const s = fakeUnigif(library());
  s.failNext("/gifs", 429, { "retry-after": "7" });
  await assert.rejects(s.client.searchGifs({ sort: "new", limit: 5 }), (e: unknown) => {
    assert.ok(e instanceof UnigifError);
    assert.equal(e.status, 429);
    assert.equal(e.code, "rate_limited");
    assert.equal(e.retryAfter, 7);
    return true;
  });
});

test("an unreachable server is a status-0 network error", async () => {
  const client = new UnigifClient({
    baseUrl: "http://nowhere.invalid",
    apiKey: "k",
    fetch: (async () => {
      throw new TypeError("fetch failed", { cause: new Error("ENOTFOUND") });
    }) as typeof fetch,
  });
  await assert.rejects(client.me(), (e: unknown) => e instanceof UnigifError && e.status === 0 && e.code === "network" && /ENOTFOUND/.test(e.message));
});

test("media URLs are fetched from the configured base, not the public URL", () => {
  const s = fakeUnigif([]);
  assert.equal(s.client.mediaUrl("https://gif.example.com/m/abc/full.mp4"), `${BASE}/m/abc/full.mp4`);
  assert.equal(s.client.mediaUrl("https://elsewhere.example/other.mp4"), "https://elsewhere.example/other.mp4");
});

test("the key is sent to the Unigif server only", async () => {
  const seen: Array<{ url: string; auth?: string }> = [];
  const client = new UnigifClient({
    baseUrl: BASE,
    apiKey: "secret",
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)["Authorization"] });
      return new Response(new Uint8Array(3));
    }) as unknown as typeof fetch,
  });
  await client.download("https://gif.example.com/m/abc/full.mp4", 100);
  await client.download("https://elsewhere.example/x.mp4", 100);
  assert.equal(seen[0]!.auth, "Bearer secret");
  assert.equal(seen[1]!.auth, undefined);
});

test("downloads are capped", async () => {
  const big = new UnigifClient({
    baseUrl: BASE,
    apiKey: "k",
    fetch: (async () => new Response(new Uint8Array(500))) as unknown as typeof fetch,
  });
  assert.equal((await big.download(`${BASE}/m/x/full.mp4`, 500)).byteLength, 500);
  await assert.rejects(big.download(`${BASE}/m/x/full.mp4`, 499), (e: unknown) => e instanceof UnigifError && e.code === "too_large");

  const declared = new UnigifClient({
    baseUrl: BASE,
    apiKey: "k",
    fetch: (async () => new Response(new Uint8Array(10), { headers: { "content-length": "999999" } })) as unknown as typeof fetch,
  });
  await assert.rejects(declared.download(`${BASE}/m/x/full.mp4`, 1000), (e: unknown) => e instanceof UnigifError && e.code === "too_large");
});
