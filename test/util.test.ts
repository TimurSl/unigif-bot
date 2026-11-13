import assert from "node:assert/strict";
import { test } from "node:test";
import { hashtagCaption, normalizeQuery, Semaphore, TtlCache, withDeadline } from "../src/util.js";

test("normalizeQuery cleans hashtags and keeps exclusions", () => {
  assert.equal(normalizeQuery("#Cat, funny -DOG!"), "cat funny -dog");
  assert.equal(normalizeQuery("  ##cat   "), "cat");
  assert.equal(normalizeQuery("!!! -"), "");
  assert.equal(normalizeQuery("кот смешной"), "кот смешной");
  assert.equal(normalizeQuery("a_b c1"), "a_b c1");
});

test("normalizeQuery keeps a trailing space only when asked, because it ends prefix matching", () => {
  assert.equal(normalizeQuery("cat "), "cat");
  assert.equal(normalizeQuery("cat ", { keepTrailing: true }), "cat ");
  assert.equal(normalizeQuery("cat,", { keepTrailing: true }), "cat ");
  assert.equal(normalizeQuery("cat", { keepTrailing: true }), "cat");
  assert.equal(normalizeQuery(" ", { keepTrailing: true }), "");
});

test("normalizeQuery caps the number of words", () => {
  assert.equal(normalizeQuery("a b c d e f g h i j").split(" ").length, 8);
});

test("hashtagCaption", () => {
  assert.equal(hashtagCaption(["cat", "funny"]), "#cat #funny");
  assert.equal(hashtagCaption([]), "");
  assert.ok(hashtagCaption(["x".repeat(2000)]).length <= 1024);
});

test("TtlCache expires entries and evicts the oldest", () => {
  let now = 0;
  const c = new TtlCache<number>(100, 2, () => now);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  now = 101;
  assert.equal(c.get("b"), undefined);
  const key = c.put(9);
  assert.equal(c.get(key), 9);
  assert.ok(key.length <= 16);
});

test("Semaphore runs at most N tasks at once", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      sem.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test("withDeadline gives up waiting but lets the work finish", async () => {
  let done = false;
  const slow = new Promise<string>((r) =>
    setTimeout(() => {
      done = true;
      r("late");
    }, 30),
  );
  assert.equal(await withDeadline(slow, 5), undefined);
  assert.equal(done, false);
  assert.equal(await slow, "late");
  assert.equal(await withDeadline(Promise.resolve("fast"), 50), "fast");
});
