import { autoRetry } from "@grammyjs/auto-retry";
import { createBot, COMMANDS } from "./bot.js";
import { ConfigError, loadConfig } from "./config.js";
import { FileIdStore } from "./store.js";
import { UnigifClient, UnigifError } from "./unigif.js";
import { createLogger } from "./util.js";

const log = createLogger((process.env["LOG_LEVEL"] as "debug" | "info" | "warn" | "error") || "info");

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new UnigifClient({ baseUrl: config.unigifUrl, apiKey: config.unigifKey });

  // Fail early, with a clear message, if the server or the key is not usable.
  const me = await client.me().catch((err: unknown) => {
    if (err instanceof UnigifError) {
      const hint = err.status === 401 ? " Check UNIGIF_API_KEY." : err.status === 0 ? " Check UNIGIF_URL." : "";
      throw new Error(`Unigif at ${config.unigifUrl} said: ${err.message}.${hint}`);
    }
    throw err;
  });
  if (!me.scopes.includes("read") && !me.scopes.includes("admin")) {
    throw new Error(`The API key "${me.name}" needs the read scope (it has: ${me.scopes.join(", ") || "none"}).`);
  }
  log.info(`Unigif OK: signed in as ${me.kind} "${me.name}"`);

  // The bot's id is the first part of its token; the file-id cache is tied to it.
  const botId = Number(config.botToken.split(":")[0]);
  const store = new FileIdStore(config.dataDir, botId, log);
  await store.load();

  const bot = createBot({ config, client, store, log });
  // Only wait out Telegram's flood limits (429). Network errors and 5xx must surface: by default this
  // plugin retries those forever, which would leave a bot with a bad connection silent instead of failing.
  bot.api.config.use(
    autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 10, rethrowHttpErrors: true, rethrowInternalServerErrors: true }),
  );

  // grammY keeps retrying while the network is down (handy when this starts before the network is up), so
  // say what is going on rather than sit silent. A wrong token fails at once instead.
  const waiting = setInterval(
    () => log.warn("still trying to reach Telegram; check the network connection"),
    15_000,
  );
  try {
    await bot.init();
  } finally {
    clearInterval(waiting);
  }
  const info = bot.botInfo;
  log.info(`Telegram OK: @${info.username}, ${store.size} GIFs already cached`);
  if (!info.supports_inline_queries) {
    log.warn("inline mode is off. In @BotFather: /setinline, pick this bot, and set a placeholder like “hashtags”.");
  }
  if (config.allowedUserIds === null) log.warn("ALLOW_ANYONE is on: anybody on Telegram can search this library.");
  if (config.storageChatId === null) {
    log.warn("STORAGE_CHAT_ID is not set: GIFs over the inline URL limit cannot be offered in inline mode.");
  }

  await bot.api.setMyCommands(COMMANDS).catch((err) => log.warn("could not set the command list", err));

  const stop = async () => {
    log.info("shutting down");
    await bot.stop();
    await store.flush();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  await bot.start({
    allowed_updates: ["message", "callback_query", "inline_query", "chosen_inline_result"],
    onStart: () => log.info("listening for updates"),
  });
  await store.flush();
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
