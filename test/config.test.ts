import assert from "node:assert/strict";
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
