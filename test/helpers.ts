import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { createBot } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { FileIdStore } from "../src/store.js";
import { UnigifClient, type Gif } from "../src/unigif.js";
import { silentLogger } from "../src/util.js";

export const BASE = "http://unigif.test";
export const PUBLIC = "https://gif.example.com";

export function baseConfig(over: Partial<Config> = {}): Config {
  return {
    botToken: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    unigifUrl: BASE,
    unigifKey: "ugf_test_secret",
    allowedUserIds: new Set([1]),
    storageChatId: null,
    dataDir: join(tmpdir(), "unigif-bot-test-unused"),
    inlinePageSize: 30,
    chatPageSize: 5,
    sort: "used",
    inlineUrlMaxBytes: 1_000_000,
    maxUploadBytes: 20_000_000,
    inlineUploadBudgetMs: 500,
    inlineCacheSecs: 30,
    telegramApiRoot: "https://api.telegram.org",
    ...over,
  };
}

export function fakeGif(id: string, tags: string[], bytes = 200_000, over: Partial<Gif> = {}): Gif {
  const file = (name: string, b: number) => ({ url: `${PUBLIC}/m/${id}/${name}`, width: 480, height: 270, bytes: b });
  return {
    id,
    status: "ready",
    tags,
    description: null,
    width: 480,
    height: 270,
    duration_ms: 2400,
    page_url: `${PUBLIC}/g/${id}`,
    media: { mp4: file("full.mp4", bytes), preview_mp4: file("preview.mp4", 40_000), poster: file("poster.webp", 5_000) },
    ...over,
  };
}

export interface FakeServer {
  client: UnigifClient;
  /** Every request the client made: method and path with query. */
  requests: Array<{ method: string; url: string; auth: string | null }>;
  /** Make the next request to a path fragment fail with a status. */
  failNext(pathFragment: string, status: number, headers?: Record<string, string>): void;
  downloads: string[];
}

/** An in-memory Unigif: search with the same rules as the real one (prefix on the last word, `-tag`). */
export function fakeUnigif(library: Gif[], opts: { mediaBytes?: number } = {}): FakeServer {
  const requests: FakeServer["requests"] = [];
  const downloads: string[] = [];
  const failures: Array<{ fragment: string; status: number; headers: Record<string, string> }> = [];

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method: init?.method ?? "GET", url: url.pathname + url.search, auth: headers["Authorization"] ?? null });

    const failIndex = failures.findIndex((f) => url.pathname.includes(f.fragment));
    if (failIndex >= 0) {
      const [f] = failures.splice(failIndex, 1);
      return json({ type: "about:blank", title: "x", status: f!.status, detail: `fake ${f!.status}`, code: "rate_limited" }, f!.status, f!.headers);
    }

    if (url.pathname === "/api/v1/me") return json({ kind: "key", name: "test key", scopes: ["read"], deny_tags: [], limits: null });

    if (url.pathname === "/api/v1/gifs") {
      const p = url.searchParams;
      const q = p.get("q") ?? "";
      const typing = q !== "" && !/[\s,]$/.test(q);
      const words = q.split(/[\s,]+/).filter(Boolean);
      const must: string[] = [];
      const exclude: string[] = [];
      let prefix: string | null = null;
      words.forEach((w, i) => {
        const bare = w.replace(/^#/, "");
        if (bare.startsWith("-")) exclude.push(bare.slice(1));
        else if (i === words.length - 1 && typing) prefix = bare;
        else must.push(bare);
      });
      let items = library.filter(
        (g) =>
          (p.get("status") ? p.get("status")!.split(",").includes(g.status) : true) &&
          must.every((t) => g.tags.includes(t)) &&
          exclude.every((t) => !g.tags.includes(t)) &&
          (prefix === null || g.tags.some((t) => t.startsWith(prefix!))),
      );
      if (p.get("sort") === "old") items = [...items].reverse();
      const limit = Number(p.get("limit") ?? 50);
      const start = Number(p.get("cursor") ?? 0);
      const slice = items.slice(start, start + limit);
      const next = start + limit < items.length ? String(start + limit) : null;
      return json({ items: slice, next_cursor: next });
    }

    if (url.pathname === "/api/v1/tags") {
      const counts = new Map<string, number>();
      for (const g of library) for (const t of g.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      const prefix = url.searchParams.get("q") ?? "";
      const items = [...counts]
        .filter(([name]) => name.startsWith(prefix))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Number(url.searchParams.get("limit") ?? 100))
        .map(([name, gif_count]) => ({ name, gif_count, last_used_at: null }));
      return json({ items, next_cursor: null });
    }

    const use = url.pathname.match(/^\/api\/v1\/gifs\/([^/]+)\/use$/);
    if (use) return new Response(null, { status: 204 });

    if (url.pathname.startsWith("/m/")) {
      downloads.push(url.pathname);
      return new Response(new Uint8Array(opts.mediaBytes ?? 1000), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    return json({ detail: "not found", code: "not_found" }, 404);
  }) as typeof fetch;

  return {
    client: new UnigifClient({ baseUrl: BASE, apiKey: "ugf_test_secret", fetch: fetchImpl }),
    requests,
    downloads,
    failNext: (fragment, status, headers = {}) => failures.push({ fragment, status, headers }),
  };
}

export interface Call {
  method: string;
  payload: Record<string, any>;
}

export interface Harness {
  bot: Bot;
  calls: Call[];
  /** Calls to one Telegram method. */
  of(method: string): Call[];
  /** Make a Telegram method fail once, as Telegram would with a 400. */
  failOnce(method: string, description: string): void;
  store: FileIdStore;
  send(update: Partial<Update>): Promise<void>;
}

let updateId = 1000;
let messageId = 1;

export function makeBot(server: FakeServer, config: Config): Harness {
  const store = new FileIdStore(mkdtempSync(join(tmpdir(), "unigif-bot-test-")), 123456, silentLogger);
  const bot = createBot({ config, client: server.client, store, log: silentLogger });
  bot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: "Unigif",
    username: "unigif_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: true,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as typeof bot.botInfo;

  const calls: Call[] = [];
  const failures: Array<{ method: string; description: string }> = [];
  let fileCounter = 0;

  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const fail = failures.findIndex((f) => f.method === method);
    if (fail >= 0) {
      const [f] = failures.splice(fail, 1);
      const { GrammyError } = await import("grammy");
      throw new GrammyError(`Call to '${method}' failed!`, { ok: false, error_code: 400, description: f!.description }, method, payload);
    }
    if (method === "sendAnimation") {
      fileCounter += 1;
      return {
        ok: true,
        result: {
          message_id: messageId++,
          date: 0,
          chat: { id: (payload as any).chat_id, type: "private" },
          animation: { file_id: `TGFILE${fileCounter}`, file_unique_id: `u${fileCounter}`, width: 480, height: 270, duration: 2 },
        },
      } as any;
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: messageId++, date: 0, chat: { id: (payload as any).chat_id, type: "private" }, text: (payload as any).text } } as any;
    }
    return { ok: true, result: true } as any;
  });

  return {
    bot,
    calls,
    of: (m) => calls.filter((c) => c.method === m),
    failOnce: (method, description) => failures.push({ method, description }),
    store,
    send: (update) => bot.handleUpdate({ update_id: updateId++, ...update } as Update),
  };
}

export const user = (id = 1) => ({ id, is_bot: false, first_name: "Tester" });

export function textMessage(text: string, from = 1, chatType: "private" | "group" = "private"): Partial<Update> {
  const entities = text.startsWith("/")
    ? [{ type: "bot_command" as const, offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  return {
    message: {
      message_id: messageId++,
      date: 0,
      chat: chatType === "private" ? { id: from, type: "private", first_name: "Tester" } : { id: -100, type: "group", title: "g" },
      from: user(from),
      text,
      entities,
    },
  } as Partial<Update>;
}

export function inlineQuery(query: string, offset = "", from = 1): Partial<Update> {
  return { inline_query: { id: `iq${updateId}`, from: user(from), query, offset, chat_type: "sender" } } as Partial<Update>;
}

export function chosenResult(resultId: string, from = 1): Partial<Update> {
  return { chosen_inline_result: { result_id: resultId, from: user(from), query: "x" } } as Partial<Update>;
}

export function callback(data: string, from = 1): Partial<Update> {
  return {
    callback_query: {
      id: `cb${updateId}`,
      from: user(from),
      chat_instance: "ci",
      data,
      message: { message_id: messageId++, date: 0, chat: { id: from, type: "private", first_name: "Tester" } },
    },
  } as Partial<Update>;
}

export function library(): Gif[] {
  return [
    fakeGif("aaaaaaaaaaaa", ["cat", "funny"]),
    fakeGif("bbbbbbbbbbbb", ["cat", "sleepy"]),
    fakeGif("cccccccccccc", ["dog", "funny"]),
    fakeGif("dddddddddddd", ["cat", "dog"], 3_000_000), // too big for an inline URL
    fakeGif("eeeeeeeeeeee", ["catnap"], 100_000),
    fakeGif("ffffffffffff", ["wip"], 100_000, { status: "processing" }),
  ];
}
