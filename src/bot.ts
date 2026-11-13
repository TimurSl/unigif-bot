/** Wires the handlers into a grammY bot. Kept apart from `index.ts` so tests can drive it without a network. */

import { Bot, type Context } from "grammy";
import { registerChat } from "./chat.js";
import type { Config } from "./config.js";
import { InlineSearch } from "./inline.js";
import { GifSender } from "./sender.js";
import type { FileIdStore } from "./store.js";
import type { UnigifClient } from "./unigif.js";
import type { Logger } from "./util.js";

export const COMMANDS = [
  { command: "gif", description: "Search GIFs by hashtag" },
  { command: "tags", description: "Browse hashtags" },
  { command: "help", description: "How to use this bot" },
];

export function createBot(deps: { config: Config; client: UnigifClient; store: FileIdStore; log: Logger }): Bot {
  const { config, client, store, log } = deps;
  const bot = new Bot(config.botToken);

  const isAllowed = (userId: number) => config.allowedUserIds === null || config.allowedUserIds.has(userId);
  const sender = new GifSender({ api: bot.api, client, store, config, log });
  const inline = new InlineSearch({ client, sender, config, isAllowed, log });

  bot.catch((err) => log.error(`unhandled error in update ${err.ctx.update.update_id}`, err.error));

  // Inline queries do their own access check so a stranger gets an explanation instead of silence.
  bot.on("inline_query", inline.onQuery);
  bot.on("chosen_inline_result", inline.onChosen);

  // Everything else is for allowed users only.
  const members = bot.filter((ctx): ctx is Context => ctx.from !== undefined && isAllowed(ctx.from.id));
  const strangers = bot.filter((ctx) => ctx.from !== undefined && !isAllowed(ctx.from.id));
  strangers.chatType("private").on("message", async (ctx) => {
    await ctx.reply(`Sorry, this bot is private.\nYour Telegram user id is ${ctx.from.id}, in case the owner wants to add you.`);
  });
  strangers.on("callback_query", (ctx) => ctx.answerCallbackQuery({ text: "This bot is private." }));

  registerChat(members, { client, sender, config, username: () => bot.botInfo?.username, log });
  return bot;
}
