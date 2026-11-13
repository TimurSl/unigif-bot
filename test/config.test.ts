import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

const ok = {
  TELEGRAM_BOT_TOKEN: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  UNIGIF_URL: "https://gif.example.com/",
  UNIGIF_API_KEY: "ugf_abc_def",
  ALLOWED_USER_IDS: "42, 7",
};

test("reads a complete configuration and applies defaults", () => {
  const c = loadConfig(ok);
  assert.equal(c.unigifUrl, "https://gif.example.com");
  assert.deepEqual([...c.allowedUserIds!].sort(), [42, 7].sort());
  assert.equal(c.storageChatId, null);
  assert.equal(c.sort, "used");
  assert.equal(c.inlinePageSize, 30);
  assert.equal(c.inlineUrlMaxBytes, 1_000_000);
});

test("lists every problem at once", () => {
  assert.throws(
    () => loadConfig({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      for (const name of ["TELEGRAM_BOT_TOKEN", "UNIGIF_URL", "UNIGIF_API_KEY", "ALLOWED_USER_IDS"]) {
        assert.match(err.message, new RegExp(name));
      }
      return true;
    },
  );
});

test("refuses to run open to everybody unless that is asked for", () => {
  const { ALLOWED_USER_IDS: _drop, ...rest } = ok;
  assert.throws(() => loadConfig(rest), /ALLOWED_USER_IDS/);
  const c = loadConfig({ ...rest, ALLOW_ANYONE: "true" });
  assert.equal(c.allowedUserIds, null);
});

test("validates ids, urls, and numbers", () => {
  assert.throws(() => loadConfig({ ...ok, ALLOWED_USER_IDS: "abc" }), /invalid user id/);
  assert.throws(() => loadConfig({ ...ok, UNIGIF_URL: "ftp://x" }), /http\(s\) URL/);
  assert.throws(() => loadConfig({ ...ok, UNIGIF_URL: "not a url" }), /http\(s\) URL/);
  assert.throws(() => loadConfig({ ...ok, TELEGRAM_BOT_TOKEN: "nope" }), /bot token/);
  assert.throws(() => loadConfig({ ...ok, INLINE_PAGE_SIZE: "51" }), /INLINE_PAGE_SIZE/);
  assert.throws(() => loadConfig({ ...ok, SORT: "random" }), /SORT/);
});

test("storage chat accepts a numeric id or a channel name", () => {
  assert.equal(loadConfig({ ...ok, STORAGE_CHAT_ID: "-1001234567890" }).storageChatId, -1001234567890);
  assert.equal(loadConfig({ ...ok, STORAGE_CHAT_ID: "@my_store" }).storageChatId, "@my_store");
  assert.throws(() => loadConfig({ ...ok, STORAGE_CHAT_ID: "somewhere" }), /STORAGE_CHAT_ID/);
});

test("secrets can come from files, so they stay out of the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "unigif-bot-secrets-"));
  writeFileSync(join(dir, "token"), "123456:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n");
  writeFileSync(join(dir, "key"), "ugf_file_key\n");
  const { TELEGRAM_BOT_TOKEN: _t, UNIGIF_API_KEY: _k, ...rest } = ok;
  const c = loadConfig({ ...rest, TELEGRAM_BOT_TOKEN_FILE: join(dir, "token"), UNIGIF_API_KEY_FILE: join(dir, "key") });
  assert.equal(c.botToken, "123456:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(c.unigifKey, "ugf_file_key");
});

test("a secret file that is missing or empty is reported by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "unigif-bot-secrets-"));
  writeFileSync(join(dir, "empty"), "\n");
  assert.throws(() => loadConfig({ ...ok, UNIGIF_API_KEY_FILE: join(dir, "nope") }), /UNIGIF_API_KEY_FILE: cannot read .*ENOENT/);
  assert.throws(() => loadConfig({ ...ok, UNIGIF_API_KEY_FILE: join(dir, "empty") }), /UNIGIF_API_KEY_FILE .* is empty/);
});

test("the Telegram API root can be changed, for a self-hosted Bot API server", () => {
  assert.equal(loadConfig(ok).telegramApiRoot, "https://api.telegram.org");
  assert.equal(loadConfig({ ...ok, TELEGRAM_API_ROOT: "http://127.0.0.1:8081/" }).telegramApiRoot, "http://127.0.0.1:8081");
  assert.throws(() => loadConfig({ ...ok, TELEGRAM_API_ROOT: "nope" }), /TELEGRAM_API_ROOT/);
});
