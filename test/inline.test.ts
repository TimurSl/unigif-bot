import assert from "node:assert/strict";
import { test } from "node:test";
import { baseConfig, chosenResult, fakeUnigif, inlineQuery, library, makeBot, PUBLIC } from "./helpers.js";

const answer = (h: ReturnType<typeof makeBot>) => h.of("answerInlineQuery").at(-1)!.payload;

test("small GIFs are answered by URL, with a preview thumbnail", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(inlineQuery("cat funny "));
  const a = answer(h);
  assert.deepEqual(a.results.map((r: any) => r.id), ["aaaaaaaaaaaa"]);
  assert.deepEqual(a.results[0], {
    type: "mpeg4_gif",
    id: "aaaaaaaaaaaa",
    mpeg4_url: `${PUBLIC}/m/aaaaaaaaaaaa/full.mp4`,
    mpeg4_width: 480,
    mpeg4_height: 270,
    mpeg4_duration: 2,
    thumbnail_url: `${PUBLIC}/m/aaaaaaaaaaaa/preview.mp4`,
    thumbnail_mime_type: "video/mp4",
    title: "#cat #funny",
  });
  assert.equal(a.is_personal, true);
});

test("an empty query lists the most used GIFs", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig({ storageChatId: 55 }));
  await h.send(inlineQuery(""));
  const req = new URL("http://x" + server.requests.find((r) => r.url.startsWith("/api/v1/gifs?"))!.url);
  assert.equal(req.searchParams.get("sort"), "used");
  assert.equal(req.searchParams.has("q"), false);
  assert.ok(answer(h).results.length > 0);
});

test("the last word matches as a prefix while typing, and exactly once a space ends it", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(inlineQuery("catn"));
  assert.deepEqual(answer(h).results.map((r: any) => r.id), ["eeeeeeeeeeee"]);
  await h.send(inlineQuery("cat "));
  assert.ok(!answer(h).results.some((r: any) => r.id === "eeeeeeeeeeee"));
});

test("typed punctuation and #-signs are cleaned up", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(inlineQuery("#cat, #funny! "));
  assert.deepEqual(answer(h).results.map((r: any) => r.id), ["aaaaaaaaaaaa"]);
});

test("a GIF too big for a URL is uploaded once to the storage chat, then answered from the cache", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig({ storageChatId: -1001 }));

  await h.send(inlineQuery("dog "));
  const first = answer(h).results;
  const big = first.find((r: any) => r.id === "dddddddddddd");
  assert.deepEqual(big, { type: "mpeg4_gif", id: "dddddddddddd", mpeg4_file_id: "TGFILE1" });
  const upload = h.of("sendAnimation");
  assert.equal(upload.length, 1);
  assert.equal(upload[0]!.payload.chat_id, -1001);
  assert.match(upload[0]!.payload.caption, /#cat #dog\ndddddddddddd/);
  assert.equal(upload[0]!.payload.disable_notification, true);
  // the small one was not uploaded; it goes by URL
  assert.ok(first.find((r: any) => r.id === "cccccccccccc").mpeg4_url);

  await h.send(inlineQuery("dog "));
  assert.equal(h.of("sendAnimation").length, 1, "no second upload");
  assert.equal(server.downloads.length, 1);
  assert.equal(answer(h).results.find((r: any) => r.id === "dddddddddddd").mpeg4_file_id, "TGFILE1");
});

test("the same big GIF requested twice at once is uploaded once", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig({ storageChatId: -1001 }));
  await Promise.all([h.send(inlineQuery("dog ")), h.send(inlineQuery("cat dog "))]);
  assert.equal(h.of("sendAnimation").length, 1);
});

test("a big GIF without a storage chat falls back to the small preview, never a too-big URL", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig({ storageChatId: null }));
  await h.send(inlineQuery("cat dog "));
  const big = answer(h).results.find((r: any) => r.id === "dddddddddddd");
  assert.equal(big.mpeg4_url, `${PUBLIC}/m/dddddddddddd/preview.mp4`);
  assert.equal(h.of("sendAnimation").length, 0);
});

test("a slow upload is left out of this answer but finishes for the next one", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig({ storageChatId: -1001, inlineUploadBudgetMs: 10 }));
  // make Telegram slow to take the upload
  const slow = h.bot.api.config;
  slow.use(async (prev, method, payload, signal) => {
    if (method === "sendAnimation") await new Promise((r) => setTimeout(r, 80));
    return prev(method, payload, signal);
  });
  await h.send(inlineQuery("cat dog "));
  assert.ok(!answer(h).results.some((r: any) => r.id === "dddddddddddd"));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(h.store.get("dddddddddddd"), "cached after the upload finished");
  await h.send(inlineQuery("cat dog "));
  assert.ok(answer(h).results.some((r: any) => r.id === "dddddddddddd" && r.mpeg4_file_id));
});

test("a stale cached file id is dropped and re-uploaded instead of failing the whole answer", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig({ storageChatId: -1001 }));
  h.store.set("dddddddddddd", "OLDFILE");
  h.failOnce("answerInlineQuery", "Bad Request: wrong file identifier/HTTP URL specified");
  await h.send(inlineQuery("cat dog "));
  const answers = h.of("answerInlineQuery");
  assert.equal(answers.length, 2);
  assert.ok(answers[1]!.payload.results.every((r: any) => !r.mpeg4_file_id));
  assert.equal(h.store.get("dddddddddddd") === "OLDFILE", false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.store.get("dddddddddddd"), "TGFILE1", "uploaded again in the background");
});

test("paging: next_offset is a short key, and the next page continues where the first stopped", async () => {
  const many = Array.from({ length: 7 }, (_, i) => library()[0] && { ...library()[0]!, id: `gif${String(i).padStart(9, "0")}` });
  const h = makeBot(fakeUnigif(many as any), baseConfig({ inlinePageSize: 3 }));
  await h.send(inlineQuery("cat "));
  const p1 = answer(h);
  assert.equal(p1.results.length, 3);
  assert.ok(p1.next_offset && Buffer.byteLength(p1.next_offset) <= 64);

  await h.send(inlineQuery("cat ", p1.next_offset));
  const p2 = answer(h);
  assert.deepEqual(p2.results.map((r: any) => r.id), ["gif000000003", "gif000000004", "gif000000005"]);
  await h.send(inlineQuery("cat ", p2.next_offset));
  const p3 = answer(h);
  assert.equal(p3.results.length, 1);
  assert.equal(p3.next_offset, "");
});

test("an unknown or mismatched offset ends the list", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(inlineQuery("cat ", "bogus"));
  assert.deepEqual(answer(h).results, []);
});

test("no results shows a hint in the picker", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(inlineQuery("unicorn "));
  const a = answer(h);
  assert.deepEqual(a.results, []);
  assert.match(a.button.text, /No GIFs for/);
});

test("strangers get nothing", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  await h.send(inlineQuery("cat ", "", 999));
  assert.deepEqual(answer(h).results, []);
  assert.match(answer(h).button.text, /private/);
  assert.equal(server.requests.length, 0, "the library was never queried");
});

test("when Unigif is down the picker says so instead of hanging", async () => {
  const server = fakeUnigif(library());
  server.failNext("/gifs", 503);
  const h = makeBot(server, baseConfig());
  await h.send(inlineQuery("cat "));
  assert.deepEqual(answer(h).results, []);
  assert.match(answer(h).button.text, /unavailable/);
});

test("rate limiting is passed on to Telegram's cache time", async () => {
  const server = fakeUnigif(library());
  server.failNext("/gifs", 429, { "retry-after": "9" });
  const h = makeBot(server, baseConfig());
  await h.send(inlineQuery("cat "));
  assert.equal(answer(h).cache_time, 9);
});

test("choosing a result records a use", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  await h.send(chosenResult("aaaaaaaaaaaa"));
  const ping = server.requests.find((r) => r.url.endsWith("/use"));
  assert.equal(ping?.method, "POST");
  assert.equal(ping?.url, "/api/v1/gifs/aaaaaaaaaaaa/use");
});

test("a failed usage ping never breaks anything", async () => {
  const server = fakeUnigif(library());
  server.failNext("/use", 500);
  const h = makeBot(server, baseConfig());
  await h.send(chosenResult("aaaaaaaaaaaa"));
});
