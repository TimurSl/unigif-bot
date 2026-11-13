import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileIdStore } from "../src/store.js";
import { silentLogger } from "../src/util.js";

test("file ids survive a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unigif-bot-"));
  const a = new FileIdStore(dir, 1, silentLogger);
  await a.load();
  a.set("gif1", "FILE1");
  a.set("gif2", "FILE2");
  a.delete("gif2");
  await a.flush();

  const b = new FileIdStore(dir, 1, silentLogger);
  await b.load();
  assert.equal(b.get("gif1"), "FILE1");
  assert.equal(b.get("gif2"), undefined);
  assert.equal(b.size, 1);
});

test("a cache written by another bot is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unigif-bot-"));
  const a = new FileIdStore(dir, 1, silentLogger);
  a.set("gif1", "FILE1");
  await a.flush();
  const b = new FileIdStore(dir, 2, silentLogger);
  await b.load();
  assert.equal(b.get("gif1"), undefined);
});

test("a corrupt cache is set aside, not fatal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unigif-bot-"));
  await writeFile(join(dir, "file-ids.json"), "{ nope");
  const s = new FileIdStore(dir, 1, silentLogger);
  await s.load();
  assert.equal(s.size, 0);
  assert.equal(await readFile(join(dir, "file-ids.json.corrupt"), "utf8"), "{ nope");
});

test("an unchanged value does not trigger a write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unigif-bot-"));
  const s = new FileIdStore(dir, 1, silentLogger);
  s.set("g", "F");
  await s.flush();
  const before = await readFile(join(dir, "file-ids.json"), "utf8");
  s.set("g", "F");
  await s.flush();
  assert.equal(await readFile(join(dir, "file-ids.json"), "utf8"), before);
});
