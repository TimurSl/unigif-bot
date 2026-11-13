import assert from "node:assert/strict";
import { test } from "node:test";
import { baseConfig, callback, fakeGif, fakeUnigif, library, makeBot, textMessage } from "./helpers.js";

const texts = (h: ReturnType<typeof makeBot>) => h.of("sendMessage").map((c) => c.payload.text as string);

test("plain text is a search; each match is sent as an animation with its hashtags", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  await h.send(textMessage("cat funny"));
  const sent = h.of("sendAnimation");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.payload.chat_id, 1);
  assert.equal(sent[0]!.payload.caption, "#cat #funny");
  assert.equal(sent[0]!.payload.width, 480);
  assert.equal(sent[0]!.payload.duration, 2);
  assert.equal(sent[0]!.payload.reply_markup, undefined, "no More button on the last page");
  assert.equal(server.downloads.length, 1);
});

test("a chat search is exact: 'cat' does not match 'catnap'", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig({ chatPageSize: 10 }));
  await h.send(textMessage("cat"));
  const captions = h.of("sendAnimation").map((c) => c.payload.caption);
  assert.ok(captions.length >= 3);
  assert.ok(!captions.some((c: string) => c.includes("catnap")));
});

test("a GIF sent once is remembered, so the second search sends the file id and downloads nothing", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  await h.send(textMessage("cat funny"));
  assert.equal(h.store.get("aaaaaaaaaaaa"), "TGFILE1");
  await h.send(textMessage("cat funny"));
  assert.equal(h.of("sendAnimation")[1]!.payload.animation, "TGFILE1");
  assert.equal(server.downloads.length, 1);
});

test("a stale file id is replaced by a fresh upload", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  h.store.set("aaaaaaaaaaaa", "OLD");
  h.failOnce("sendAnimation", "Bad Request: wrong file identifier/HTTP URL specified");
  await h.send(textMessage("cat funny"));
  assert.equal(h.of("sendAnimation").length, 2);
  assert.equal(h.store.get("aaaaaaaaaaaa"), "TGFILE1");
  assert.equal(server.downloads.length, 1);
});

test("results come in pages; More fetches the next page and removes its own button", async () => {
  const many = Array.from({ length: 7 }, (_, i) => fakeGif(`m${String(i).padStart(11, "0")}`, ["meme"]));
  const h = makeBot(fakeUnigif(many), baseConfig({ chatPageSize: 3 }));
  await h.send(textMessage("meme"));
  const first = h.of("sendAnimation");
  assert.equal(first.length, 3);
  assert.equal(first[0]!.payload.reply_markup, undefined);
  const button = first[2]!.payload.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, "More ▸");
  assert.ok(Buffer.byteLength(button.callback_data) <= 64);

  await h.send(callback(button.callback_data));
  assert.equal(h.of("editMessageReplyMarkup").length, 1);
  const second = h.of("sendAnimation").slice(3);
  assert.deepEqual(second.map((c) => c.payload.caption), ["#meme", "#meme", "#meme"]);
  assert.ok(second[2]!.payload.reply_markup, "still more after page two");

  const next = second[2]!.payload.reply_markup.inline_keyboard[0][0].callback_data;
  await h.send(callback(next));
  const third = h.of("sendAnimation").slice(6);
  assert.equal(third.length, 1);
  assert.equal(third[0]!.payload.reply_markup, undefined);
});

test("an expired More button says so", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(callback("m:gone"));
  assert.match(h.of("answerCallbackQuery").at(-1)!.payload.text, /expired/);
  assert.equal(h.of("sendAnimation").length, 0);
});

test("no results explains what to do", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("unicorn -cat"));
  assert.match(texts(h)[0]!, /No GIFs for #unicorn -cat/);
  assert.match(texts(h)[0]!, /\/tags/);
});

test("/gif with no words sends the most used GIFs", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  await h.send(textMessage("/gif"));
  assert.ok(h.of("sendAnimation").length > 0);
  assert.ok(server.requests.some((r) => r.url.includes("sort=used") && !r.url.includes("q=")));
});

test("/gif with words searches, and rejects words that can't be hashtags", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("/gif cat sleepy"));
  assert.deepEqual(h.of("sendAnimation").map((c) => c.payload.caption), ["#cat #sleepy"]);
  await h.send(textMessage("/gif !!!"));
  assert.match(texts(h).at(-1)!, /letters, digits and underscores/);
});

test("/tags lists the most used hashtags as buttons that run a search", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("/tags"));
  const msg = h.of("sendMessage").at(-1)!;
  const buttons = msg.payload.reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text, "#cat 3");
  assert.equal(buttons[0].callback_data, "t:cat");

  await h.send(callback("t:wip"));
  assert.match(texts(h).at(-1)!, /No GIFs for #wip/, "processing GIFs are not sent");
  await h.send(callback("t:cat"));
  assert.ok(h.of("sendAnimation").length >= 1);
});

test("/tags with a prefix filters", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("/tags ca"));
  const names = h.of("sendMessage").at(-1)!.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.deepEqual(names.sort(), ["t:cat", "t:catnap"]);
  await h.send(textMessage("/tags zzz"));
  assert.match(texts(h).at(-1)!, /No hashtags start with/);
});

test("/start explains the bot, using the bot's own username, as plain text", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("/start"));
  const msg = h.of("sendMessage").at(-1)!.payload;
  assert.match(msg.text, /@unigif_bot/);
  assert.equal(msg.parse_mode, undefined);
});

test("an unknown command gets a pointer to /help", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("/nope"));
  assert.match(texts(h)[0]!, /\/help/);
});

test("strangers are told their id and nothing else happens", async () => {
  const server = fakeUnigif(library());
  const h = makeBot(server, baseConfig());
  await h.send(textMessage("cat", 999));
  assert.match(texts(h)[0]!, /private/);
  assert.match(texts(h)[0]!, /999/);
  assert.equal(h.of("sendAnimation").length, 0);
  assert.equal(server.requests.length, 0);
  await h.send(callback("t:cat", 999));
  assert.equal(h.of("sendAnimation").length, 0);
});

test("ALLOW_ANYONE lets everybody in", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig({ allowedUserIds: null }));
  await h.send(textMessage("cat funny", 999));
  assert.equal(h.of("sendAnimation").length, 1);
});

test("the bot stays quiet in groups", async () => {
  const h = makeBot(fakeUnigif(library()), baseConfig());
  await h.send(textMessage("cat funny", 1, "group"));
  assert.equal(h.calls.length, 0);
});

test("when Unigif is unreachable the user is told, not left waiting", async () => {
  const server = fakeUnigif(library());
  server.failNext("/gifs", 503);
  const h = makeBot(server, baseConfig());
  await h.send(textMessage("cat"));
  assert.match(texts(h).at(-1)!, /Something went wrong/);
});

test("rate limiting by Unigif is reported with the wait time", async () => {
  const server = fakeUnigif(library());
  server.failNext("/gifs", 429, { "retry-after": "12" });
  const h = makeBot(server, baseConfig());
  await h.send(textMessage("cat"));
  assert.match(texts(h).at(-1)!, /12 seconds/);
});
