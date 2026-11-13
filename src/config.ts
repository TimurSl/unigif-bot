/** Runtime configuration, read from environment variables. */

import { readFileSync } from "node:fs";

export interface Config {
  /** Telegram bot token from @BotFather. */
  botToken: string;
  /** Base URL of the Unigif server, without a trailing slash. */
  unigifUrl: string;
  /** Unigif API key (`ugf_…`) with at least the `read` scope. */
  unigifKey: string;
  /** Telegram user ids allowed to use the bot; `null` means everybody. */
  allowedUserIds: Set<number> | null;
  /**
   * A private chat or channel (the bot must be able to post there) where GIFs are uploaded once so that
   * Telegram hands back a reusable `file_id`. Optional but strongly recommended.
   */
  storageChatId: string | number | null;
  /** Where the file_id cache lives. */
  dataDir: string;
  /** Results per inline answer (Telegram allows up to 50). */
  inlinePageSize: number;
  /** GIFs sent per search in a chat. */
  chatPageSize: number;
  /** Ordering for searches and for the empty inline query. */
  sort: "new" | "old" | "used";
  /**
   * Largest MP4 that is handed to Telegram as a plain URL in an inline result. Telegram documents 1 MB for
   * URL results; bigger files are uploaded once and answered with a cached `file_id`.
   */
  inlineUrlMaxBytes: number;
  /** Largest file the bot downloads from Unigif to upload to Telegram (Telegram's upload limit is 50 MB). */
  maxUploadBytes: number;
  /** How long an inline query may wait for uploads before answering with what is ready, in ms. */
  inlineUploadBudgetMs: number;
  /** How long Telegram may cache an inline answer, in seconds. */
  inlineCacheSecs: number;
  /** Where the Bot API lives; change it to use a self-hosted Bot API server. */
  telegramApiRoot: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

/**
 * A secret is given either directly (`NAME`) or as the path of a file holding it (`NAME_FILE`), which is how
 * systemd credentials, Docker secrets and agenix / sops-nix hand secrets over without putting them in the
 * environment.
 */
function secret(env: Env, name: string, problems: string[]): string {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      const v = readFileSync(file, "utf8").trim();
      if (!v) problems.push(`${name}_FILE (${file}) is empty`);
      return v;
    } catch (err) {
      problems.push(`${name}_FILE: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return "";
    }
  }
  return required(env, name, problems);
}

function required(env: Env, name: string, problems: string[]): string {
  const v = env[name]?.trim();
  if (!v) problems.push(`${name} is required`);
  return v ?? "";
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return n;
}

function bool(env: Env, name: string): boolean {
  return ["1", "true", "yes", "on"].includes(env[name]?.trim().toLowerCase() ?? "");
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const botToken = secret(env, "TELEGRAM_BOT_TOKEN", problems);
  if (botToken && !/^\d+:[\w-]{20,}$/.test(botToken)) {
    problems.push("TELEGRAM_BOT_TOKEN does not look like a bot token (expected 123456:ABC…)");
  }

  let unigifUrl = required(env, "UNIGIF_URL", problems).replace(/\/+$/, "");
  if (unigifUrl) {
    try {
      const u = new URL(unigifUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      if (u.search || u.hash) throw new Error("query");
    } catch {
      problems.push("UNIGIF_URL must be an http(s) URL such as https://gif.example.com");
      unigifUrl = "";
    }
  }

  const unigifKey = secret(env, "UNIGIF_API_KEY", problems);

  let allowedUserIds: Set<number> | null = null;
  const rawAllowed = env["ALLOWED_USER_IDS"]?.trim();
  if (rawAllowed) {
    allowedUserIds = new Set();
    for (const part of rawAllowed.split(/[\s,]+/).filter(Boolean)) {
      const id = Number(part);
      if (!Number.isSafeInteger(id) || id <= 0) {
        problems.push(`ALLOWED_USER_IDS has an invalid user id: ${JSON.stringify(part)}`);
      } else {
        allowedUserIds.add(id);
      }
    }
  } else if (!bool(env, "ALLOW_ANYONE")) {
    problems.push(
      "set ALLOWED_USER_IDS to the Telegram user ids that may use the bot (comma separated), " +
        "or ALLOW_ANYONE=true to let everybody search your library",
    );
  }

  let storageChatId: string | number | null = null;
  const rawStorage = env["STORAGE_CHAT_ID"]?.trim();
  if (rawStorage) {
    if (/^-?\d+$/.test(rawStorage)) {
      const n = Number(rawStorage);
      if (Number.isSafeInteger(n)) storageChatId = n;
      else problems.push("STORAGE_CHAT_ID is not a valid chat id");
    } else if (/^@\w+$/.test(rawStorage)) {
      storageChatId = rawStorage;
    } else {
      problems.push("STORAGE_CHAT_ID must be a numeric chat id or @channelname");
    }
  }

  const sort = (env["SORT"]?.trim() || "used") as Config["sort"];
  if (!["new", "old", "used"].includes(sort)) problems.push("SORT must be new, old or used");

  let telegramApiRoot = (env["TELEGRAM_API_ROOT"]?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
  try {
    const u = new URL(telegramApiRoot);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
  } catch {
    problems.push("TELEGRAM_API_ROOT must be an http(s) URL such as https://api.telegram.org");
    telegramApiRoot = "https://api.telegram.org";
  }

  const config: Config = {
    botToken,
    unigifUrl,
    unigifKey,
    allowedUserIds,
    storageChatId,
    dataDir: env["DATA_DIR"]?.trim() || "./data",
    inlinePageSize: integer(env, "INLINE_PAGE_SIZE", 30, 1, 50, problems),
    chatPageSize: integer(env, "CHAT_PAGE_SIZE", 5, 1, 10, problems),
    sort,
    inlineUrlMaxBytes: integer(env, "INLINE_URL_MAX_BYTES", 1_000_000, 0, 50_000_000, problems),
    maxUploadBytes: integer(env, "MAX_UPLOAD_BYTES", 20_000_000, 1, 50_000_000, problems),
    inlineUploadBudgetMs: integer(env, "INLINE_UPLOAD_BUDGET_MS", 4000, 0, 20_000, problems),
    inlineCacheSecs: integer(env, "INLINE_CACHE_SECS", 30, 0, 3600, problems),
    telegramApiRoot,
  };

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return config;
}
