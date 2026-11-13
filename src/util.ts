/** Small helpers shared by the bot. */

import { randomBytes } from "node:crypto";

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(level: "debug" | "info" | "warn" | "error" = "info"): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const emit = (lvl: keyof typeof order) => (msg: string, extra?: unknown) => {
    if (order[lvl] < order[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    const out = lvl === "error" || lvl === "warn" ? console.error : console.log;
    if (extra === undefined) out(line);
    else out(line, extra instanceof Error ? extra.message : extra);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Turn what a person typed into a Unigif search query: `#Cat, funny -dog!` becomes `cat funny -dog`.
 * Hashtags only hold letters, digits and underscores, so anything else is dropped. A leading `-` excludes a
 * hashtag. With `keepTrailing`, a query that ended in a space or comma keeps that, because the server
 * matches the last word as a prefix only while it is still being typed.
 */
export function normalizeQuery(text: string, opts: { keepTrailing?: boolean } = {}): string {
  const words: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    if (!raw) continue;
    const negate = raw.startsWith("-");
    const body = (negate ? raw.slice(1) : raw).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
    if (!body) continue;
    words.push(negate ? `-${body}` : body);
    if (words.length === 8) break;
  }
  const query = words.join(" ");
  return query && opts.keepTrailing && /[\s,]$/.test(text) ? `${query} ` : query;
}

/** `#cat #funny` for a GIF's hashtags, kept inside Telegram's caption limit. */
export function hashtagCaption(tags: string[]): string {
  const caption = tags.map((t) => `#${t}`).join(" ");
  return caption.length <= 1024 ? caption : `${caption.slice(0, 1020)}…`;
}

/** A map whose entries expire and that never grows past `max` (oldest entries go first). */
export class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Store a value under a fresh short random key and return the key. */
  put(value: V): string {
    const key = randomBytes(6).toString("base64url");
    this.set(key, value);
    return key;
  }
}

/** Lets at most `limit` tasks run at the same time; the rest wait their turn. */
export class Semaphore {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(limit: number) {
    this.#free = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

/** Resolve with the promise's value, or `undefined` once `ms` have passed (the promise keeps running). */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
