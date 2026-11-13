/** Private-chat features: search by sending hashtags, page through results, browse hashtags. */

import { InlineKeyboard, type Composer, type Context } from "grammy";
import type { Config } from "./config.js";
import type { GifSender } from "./sender.js";
import { UnigifError, type UnigifClient } from "./unigif.js";
import { normalizeQuery, TtlCache, type Logger } from "./util.js";

type ChatConfig = Pick<Config, "chatPageSize" | "sort">;

interface Continuation {
  q: string;
  cursor: string;
}

export const HELP = [
  "Send me hashtags and I'll send back the matching GIFs from your Unigif library.",
  "",
  "• cat funny – GIFs that have both hashtags",
  "• cat -dog – tagged cat, but not dog",
  "• /gif – your most used GIFs",
  "• /tags – browse hashtags (/tags ca filters by prefix)",
  "",
  "In any chat, type @{username} followed by hashtags to send a GIF right there.",
].join("\n");

const TAG_BUTTONS = 36;

/** Telegram limits `callback_data` to 64 bytes. */
function fitsCallback(data: string): boolean {
  return Buffer.byteLength(data) <= 64;
}

export function registerChat(
  bot: Composer<Context>,
  deps: {
    client: UnigifClient;
    sender: GifSender;
    config: ChatConfig;
    username: () => string | undefined;
    log: Logger;
  },
): void {
  const { client, sender, config, log } = deps;
  const more = new TtlCache<Continuation>(60 * 60_000, 500);
  const help = () => HELP.replace("{username}", deps.username() ?? "yourbot");

  // Messages are only handled in private chats, so the bot stays quiet if it is added to a group.
  const priv = bot.chatType("private");

  priv.command(["start", "help"], async (ctx) => {
    await ctx.reply(help());
  });

  priv.command(["gif", "search"], async (ctx) => {
    const text = ctx.match.trim();
    const q = normalizeQuery(text);
    if (text && !q) {
      await ctx.reply("Hashtags can only contain letters, digits and underscores.");
      return;
    }
    await search(ctx, q);
  });

  priv.command("tags", async (ctx) => {
    const prefix = normalizeQuery(ctx.match).split(" ")[0] ?? "";
    let tags;
    try {
      tags = await client.listTags({ q: prefix || undefined, sort: "popular", limit: TAG_BUTTONS });
    } catch (err) {
      await replyError(ctx, err);
      return;
    }
    const usable = tags.filter((t) => fitsCallback(`t:${t.name}`));
    if (usable.length === 0) {
      await ctx.reply(prefix ? `No hashtags start with “${prefix}”.` : "There are no hashtags yet.");
      return;
    }
    const keyboard = new InlineKeyboard();
    usable.forEach((t, i) => {
      keyboard.text(`#${t.name} ${t.gif_count}`, `t:${t.name}`);
      if (i % 2 === 1) keyboard.row();
    });
    await ctx.reply(prefix ? `Hashtags starting with “${prefix}”:` : "Most used hashtags:", {
      reply_markup: keyboard,
    });
  });

  // Plain text is a search. Unknown /commands are not.
  priv.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply("I don't know that command. Send /help to see what I can do.");
      return;
    }
    const q = normalizeQuery(text);
    if (!q) {
      await ctx.reply("Send me hashtags, like: cat funny");
      return;
    }
    await search(ctx, q);
  });

  bot.callbackQuery(/^t:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const q = normalizeQuery(ctx.match[1] ?? "");
    if (q) await search(ctx, q);
  });

  bot.callbackQuery(/^m:(.+)$/, async (ctx) => {
    const next = more.get(ctx.match[1] ?? "");
    if (!next) {
      await ctx.answerCallbackQuery({ text: "That search has expired. Send it again." });
      return;
    }
    await ctx.answerCallbackQuery();
    // Take the button off the message it was on, so a second tap cannot ask for the same page twice.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await search(ctx, next.q, next.cursor);
  });

  async function search(ctx: Context, q: string, cursor?: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    try {
      await ctx.replyWithChatAction("upload_video").catch(() => {});
      const page = await client.searchGifs({ q, sort: config.sort, limit: config.chatPageSize, cursor, exact: true });

      if (page.items.length === 0) {
        if (cursor) {
          await ctx.reply("That was the last of them.");
        } else if (q) {
          await ctx.reply(`No GIFs for ${q.split(" ").map((w) => (w.startsWith("-") ? w : `#${w}`)).join(" ")}. Try /tags to see what's there.`);
        } else {
          await ctx.reply("The library has no GIFs yet.");
        }
        return;
      }

      // Download everything first, in parallel, then send in order so the chat reads top to bottom.
      const prepared = await Promise.all(page.items.map((gif) => sender.prepare(gif)));
      const nextKey = page.next_cursor ? more.put({ q, cursor: page.next_cursor }) : null;
      for (const [i, item] of prepared.entries()) {
        const last = i === prepared.length - 1;
        await sender.send(chatId, item, {
          reply_markup: last && nextKey ? new InlineKeyboard().text("More ▸", `m:${nextKey}`) : undefined,
        });
      }
    } catch (err) {
      log.warn(`chat search for ${JSON.stringify(q)} failed`, err);
      await replyError(ctx, err);
    }
  }
}

async function replyError(ctx: Context, err: unknown): Promise<void> {
  let text = "Something went wrong. Try again in a moment.";
  if (err instanceof UnigifError) {
    if (err.status === 429) text = `Too many requests. Try again in ${err.retryAfter ?? "a few"} seconds.`;
    else if (err.status === 0) text = "I can't reach the Unigif server right now.";
    else if (err.status === 401 || err.status === 403) text = "The bot's Unigif API key was refused. Tell the owner.";
  }
  await ctx.reply(text).catch(() => {});
}
