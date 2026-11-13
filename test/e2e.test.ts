/**
 * End-to-end against a real Unigif server (and real ffmpeg). Skipped unless UNIGIF_BIN points at the
 * `unigif` binary, e.g. `UNIGIF_BIN=../unigif/target/debug/unigif npm test`. Telegram itself is faked.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { InputFile } from "grammy";
import { UnigifClient } from "../src/unigif.js";
import { baseConfig, callback, chosenResult, inlineQuery, makeBot, textMessage, type FakeServer } from "./helpers.js";

const BIN = process.env["UNIGIF_BIN"];
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const skip = !BIN || !hasFfmpeg ? "set UNIGIF_BIN (and have ffmpeg installed) to run" : false;

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC = "https://gif.example.com";
let server: ChildProcess | undefined;
let readKey = "";
let fullKey = "";
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  const dir = mkdtempSync(join(tmpdir(), "unigif-e2e-"));
  const env = {
    ...process.env,
    UNIGIF_DATA_DIR: join(dir, "data"),
    UNIGIF_CACHE_DIR: join(dir, "cache"),
    UNIGIF_LISTEN: `127.0.0.1:${PORT}`,
    UNIGIF_PUBLIC_URL: PUBLIC,
  };
  const run = (...args: string[]) => execFileSync(BIN!, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  writeFileSync(join(dir, "pw"), "e2e-password-123\n");
  run("user", "add", "owner", "--password-file", join(dir, "pw"));
  readKey = run("key", "create", "--name", "bot", "--preset", "read_only");
  fullKey = run("key", "create", "--name", "uploader", "--preset", "full");

  server = spawn(BIN!, ["serve"], { env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/v1/me`).then((r) => r.status === 401, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const add = async (name: string, color: string, tags: string) => {
    const gif = join(dir, `${name}.gif`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x120:r=10:d=2`, "-vf", "format=rgb24", gif]);
    const res = await fetch(`${BASE}/api/v1/gifs?tags=${tags}&source=api&source_id=${name}&wait=30`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "image/gif" },
      body: new Uint8Array(execFileSync("cat", [gif])),
    });
    const body = (await res.json()) as { id: string; status: string };
    assert.equal(body.status, "ready", `${name} should be ready`);
    ids[name] = body.id;
  };
  await add("red", "red", "color,warm,cat");
  await add("blue", "blue", "color,cold");
  await add("green", "green", "color,cat,funny");
});

after(() => {
  server?.kill();
});

const harness = (over = {}) => {
  const client = new UnigifClient({ baseUrl: BASE, apiKey: readKey });
  return makeBot({ client } as FakeServer, baseConfig({ unigifUrl: BASE, ...over }));
};

test("the bot's key is accepted and has the read scope", { skip }, async () => {
  const me = await new UnigifClient({ baseUrl: BASE, apiKey: readKey }).me();
  assert.deepEqual(me.scopes, ["read"]);
});

test("inline: hashtags find the right GIFs, answered by their public URL", { skip }, async () => {
  const h = harness();
  await h.send(inlineQuery("cat "));
  const results = h.of("answerInlineQuery").at(-1)!.payload.results;
  assert.deepEqual(results.map((r: any) => r.id).sort(), [ids["green"], ids["red"]].sort());
  for (const r of results) {
    assert.match(r.mpeg4_url, new RegExp(`^${PUBLIC}/m/${r.id}/full\\.mp4$`));
    assert.match(r.thumbnail_url, /preview\.mp4$/);
    assert.equal(r.mpeg4_width, 160);
    assert.equal(r.mpeg4_height, 120);
  }

  await h.send(inlineQuery("cat funny "));
  assert.deepEqual(h.of("answerInlineQuery").at(-1)!.payload.results.map((r: any) => r.id), [ids["green"]]);
  await h.send(inlineQuery("col"));
  assert.equal(h.of("answerInlineQuery").at(-1)!.payload.results.length, 3, "prefix matches while typing");
  await h.send(inlineQuery("color -cat"));
  assert.deepEqual(h.of("answerInlineQuery").at(-1)!.payload.results.map((r: any) => r.id), [ids["blue"]]);
});

test("inline: choosing a GIF moves it to the top of the empty-query list", { skip }, async () => {
  const h = harness();
  await h.send(chosenResult(ids["blue"]!));
  await h.send(inlineQuery(""));
  assert.equal(h.of("answerInlineQuery").at(-1)!.payload.results[0].id, ids["blue"]);
});

test("chat: the bot downloads the real MP4 from the server and uploads it to Telegram", { skip }, async () => {
  const h = harness();
  await h.send(textMessage("cat funny"));
  const sent = h.of("sendAnimation");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.payload.caption, "#cat #color #funny");
  const file = sent[0]!.payload.animation as InputFile;
  assert.ok(file instanceof InputFile);
  const bytes = file["fileData"] as Uint8Array;
  assert.equal(Buffer.from(bytes.subarray(4, 8)).toString(), "ftyp", "a real MP4 came over the wire");
  assert.ok(bytes.byteLength > 500);

  await h.send(textMessage("cat funny"));
  assert.equal(h.of("sendAnimation")[1]!.payload.animation, "TGFILE1", "second time from the file id");
});

test("chat: /tags shows the real hashtags with counts, and a tag button sends its GIFs", { skip }, async () => {
  const h = harness();
  await h.send(textMessage("/tags"));
  const buttons = h.of("sendMessage").at(-1)!.payload.reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text, "#color 3");
  await h.send(callback("t:cold"));
  assert.equal(h.of("sendAnimation").length, 1);
});

test("chat: paging through the real cursor", { skip }, async () => {
  const h = harness({ chatPageSize: 2 });
  await h.send(textMessage("color"));
  assert.equal(h.of("sendAnimation").length, 2);
  const more = h.of("sendAnimation")[1]!.payload.reply_markup.inline_keyboard[0][0].callback_data;
  await h.send(callback(more));
  assert.equal(h.of("sendAnimation").length, 3);
  const all = h.of("sendAnimation").map((c) => c.payload.caption);
  assert.equal(new Set(all).size, 3, "no GIF repeated across pages");
});

test("a revoked or wrong key is reported clearly", { skip }, async () => {
  const bad = new UnigifClient({ baseUrl: BASE, apiKey: "ugf_nope_nope" });
  await assert.rejects(bad.me(), (e: any) => e.status === 401);
});
