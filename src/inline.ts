/**
 * Inline mode: `@yourbot cat funny` in any chat lists matching GIFs from the library.
 *
 * Telegram only takes inline results by URL for small files (about 1 MB), so a GIF is answered from the
 * `file_id` cache when it is there, by URL when it is small, and otherwise uploaded once to the storage
 * chat and answered from the cache.
 */

import { GrammyError, type Context } from "grammy";
import type { InlineQueryResult } from "grammy/types";
import type { Config } from "./config.js";
import { isStaleFileIdError, type GifSender } from "./sender.js";
import type { PlayableGif, Sort, UnigifClient } from "./unigif.js";
import { UnigifError } from "./unigif.js";
import { hashtagCaption, normalizeQuery, TtlCache, withDeadline, type Logger } from "./util.js";

type InlineConfig = Pick<
  Config,
  "inlinePageSize" | "sort" | "inlineUrlMaxBytes" | "inlineUploadBudgetMs" | "inlineCacheSecs"
>;

interface Continuation {
  q: string;
  cursor: string;
}

export class InlineSearch {
  /** `next_offset` is limited to 64 bytes, so the server's cursor is kept here and a short key is handed out. */
  readonly #continuations = new TtlCache<Continuation>(30 * 60_000, 500);
  #warnedNoStorage = false;

  constructor(
    private readonly deps: {
      client: UnigifClient;
      sender: GifSender;
      config: InlineConfig;
      isAllowed: (userId: number) => boolean;
      log: Logger;
    },
  ) {}

  /** Handler for `inline_query` updates. */
  readonly onQuery = async (ctx: Context): Promise<void> => {
    const iq = ctx.inlineQuery;
    if (!iq) return;
    const { config, client, isAllowed, log } = this.deps;

    if (!isAllowed(iq.from.id)) {
      await ctx.answerInlineQuery([], {
        cache_time: 60,
        is_personal: true,
        button: { text: "This bot is private", start_parameter: "private" },
      });
      return;
    }

    const q = normalizeQuery(iq.query, { keepTrailing: true });
    let cursor: string | undefined;
    if (iq.offset) {
      const next = this.#continuations.get(iq.offset);
      if (!next || next.q !== q) {
        await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
        return;
      }
      cursor = next.cursor;
    }

    let gifs: PlayableGif[];
    let nextCursor: string | null;
    try {
      const sort: Sort = config.sort;
      const page = await client.searchGifs({ q, sort, limit: config.inlinePageSize, cursor });
      gifs = page.items;
      nextCursor = page.next_cursor;
    } catch (err) {
      log.warn(`inline search for ${JSON.stringify(q)} failed`, err);
      const busy = err instanceof UnigifError && err.status === 429;
      await ctx.answerInlineQuery([], {
        cache_time: busy ? (err.retryAfter ?? 2) : 0,
        is_personal: true,
        button: { text: busy ? "Too many searches, try again" : "Unigif is unavailable", start_parameter: "help" },
      });
      return;
    }

    const built = await this.#buildResults(gifs);
    const nextOffset = nextCursor ? this.#continuations.put({ q, cursor: nextCursor }) : undefined;

    const options = {
      cache_time: config.inlineCacheSecs,
      is_personal: true,
      next_offset: nextOffset ?? "",
      ...(built.length === 0 && !cursor
        ? { button: { text: q ? `No GIFs for “${q}”` : "The library is empty", start_parameter: "help" } }
        : {}),
    };

    try {
      await ctx.answerInlineQuery(built.map((b) => b.result), options);
    } catch (err) {
      await this.#recover(ctx, err, built, options);
    }
  };

  /** Handler for `chosen_inline_result` updates (needs inline feedback enabled in @BotFather). */
  readonly onChosen = async (ctx: Context): Promise<void> => {
    const chosen = ctx.chosenInlineResult;
    if (!chosen) return;
    try {
      await this.deps.client.markUsed(chosen.result_id);
    } catch (err) {
      this.deps.log.warn(`could not record the use of ${chosen.result_id}`, err);
    }
  };

  async #buildResults(gifs: PlayableGif[]): Promise<Built[]> {
    const { sender, config, log } = this.deps;
    const results = await Promise.all(
      gifs.map(async (gif): Promise<Built | null> => {
        const fileId = sender.cachedFileId(gif.id);
        if (fileId) return cachedResult(gif, fileId);

        const { mp4, preview_mp4: preview } = gif.media;
        if (mp4.bytes <= config.inlineUrlMaxBytes) return urlResult(gif, mp4.url, mp4.width, mp4.height);

        if (!sender.hasStorageChat) {
          if (!this.#warnedNoStorage) {
            this.#warnedNoStorage = true;
            log.warn(
              "some GIFs are too big to give Telegram by URL and STORAGE_CHAT_ID is not set; " +
                "the smaller preview is offered instead",
            );
          }
          return preview && preview.bytes <= config.inlineUrlMaxBytes
            ? urlResult(gif, preview.url, preview.width, preview.height)
            : null;
        }

        // Upload it now if that is quick enough; otherwise it is ready for the next search.
        const uploaded = await withDeadline(sender.fileIdFor(gif).catch(() => undefined), config.inlineUploadBudgetMs);
        return uploaded ? cachedResult(gif, uploaded) : null;
      }),
    );
    return results.filter((r): r is Built => r !== null);
  }

  /**
   * Telegram rejects the whole answer if one result is bad. The usual cause is a cached `file_id` that is
   * no longer valid, so drop those, queue them for a fresh upload, and answer again with the rest.
   */
  async #recover(
    ctx: Context,
    err: unknown,
    built: Built[],
    options: Parameters<Context["answerInlineQuery"]>[1],
  ): Promise<void> {
    const { sender, log } = this.deps;
    const cached = built.filter((b) => b.cached);
    if (!(err instanceof GrammyError) || err.error_code !== 400 || cached.length === 0) {
      log.warn("could not answer the inline query", err);
      return;
    }
    log.warn(
      isStaleFileIdError(err)
        ? "Telegram rejected a cached file id; refreshing"
        : `Telegram rejected the inline answer (${err.description}); retrying without cached GIFs`,
    );
    for (const b of cached) {
      sender.forget(b.gif.id);
      if (sender.hasStorageChat) void sender.fileIdFor(b.gif).catch(() => undefined);
    }
    try {
      await ctx.answerInlineQuery(
        built.filter((b) => !b.cached).map((b) => b.result),
        options,
      );
    } catch (retryErr) {
      log.warn("could not answer the inline query", retryErr);
    }
  }
}

interface Built {
  gif: PlayableGif;
  cached: boolean;
  result: InlineQueryResult;
}

function cachedResult(gif: PlayableGif, fileId: string): Built {
  return {
    gif,
    cached: true,
    result: { type: "mpeg4_gif", id: gif.id, mpeg4_file_id: fileId },
  };
}

function urlResult(gif: PlayableGif, url: string, width: number, height: number): Built {
  const preview = gif.media.preview_mp4 ?? gif.media.mp4;
  const result: InlineQueryResult = {
    type: "mpeg4_gif",
    id: gif.id,
    mpeg4_url: url,
    mpeg4_width: width,
    mpeg4_height: height,
    thumbnail_url: preview.url,
    thumbnail_mime_type: "video/mp4",
  };
  if (gif.duration_ms) result.mpeg4_duration = Math.max(1, Math.round(gif.duration_ms / 1000));
  const title = hashtagCaption(gif.tags);
  if (title) result.title = title.slice(0, 100);
  return { gif, cached: false, result };
}
