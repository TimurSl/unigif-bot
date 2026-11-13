/**
 * Gets GIFs from Unigif into Telegram. A GIF is uploaded once; Telegram answers with a `file_id` that is
 * remembered, and every later send (in a chat or as an inline result) reuses it.
 */

import { GrammyError, InputFile, type Api } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import type { FileIdStore } from "./store.js";
import type { PlayableGif, UnigifClient } from "./unigif.js";
import { hashtagCaption, Semaphore, type Logger } from "./util.js";

/** A GIF that is either already on Telegram (`fileId`) or downloaded and ready to upload (`bytes`). */
export type Prepared = { gif: PlayableGif; fileId: string } | { gif: PlayableGif; bytes: Uint8Array };

type AnimationOptions = NonNullable<Parameters<Api["sendAnimation"]>[2]>;

const STALE_FILE_ID = /wrong (remote )?file identifier|file reference|FILE_REFERENCE/i;

export function isStaleFileIdError(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400 && STALE_FILE_ID.test(err.description);
}

export class GifSender {
  readonly #api: Api;
  readonly #client: UnigifClient;
  readonly #store: FileIdStore;
  readonly #storageChatId: Config["storageChatId"];
  readonly #maxUploadBytes: number;
  readonly #log: Logger;
  readonly #uploads = new Semaphore(3);
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(deps: {
    api: Api;
    client: UnigifClient;
    store: FileIdStore;
    config: Pick<Config, "storageChatId" | "maxUploadBytes">;
    log: Logger;
  }) {
    this.#api = deps.api;
    this.#client = deps.client;
    this.#store = deps.store;
    this.#storageChatId = deps.config.storageChatId;
    this.#maxUploadBytes = deps.config.maxUploadBytes;
    this.#log = deps.log;
  }

  /** Whether GIFs can be uploaded ahead of time, for inline results, to the storage chat. */
  get hasStorageChat(): boolean {
    return this.#storageChatId !== null;
  }

  cachedFileId(gifId: string): string | undefined {
    return this.#store.get(gifId);
  }

  forget(gifId: string): void {
    this.#store.delete(gifId);
  }

  /**
   * Upload a GIF to the storage chat (once; concurrent callers share the work) and return its `file_id`.
   * The upload keeps running if a caller stops waiting for it.
   */
  fileIdFor(gif: PlayableGif): Promise<string> {
    const known = this.#store.get(gif.id);
    if (known) return Promise.resolve(known);
    if (this.#storageChatId === null) return Promise.reject(new Error("STORAGE_CHAT_ID is not set"));

    let job = this.#inFlight.get(gif.id);
    if (!job) {
      const chatId = this.#storageChatId;
      job = this.#uploads
        .run(async () => {
          const bytes = await this.#client.download(gif.media.mp4.url, this.#maxUploadBytes);
          const msg = await this.#api.sendAnimation(chatId, this.#file(gif, bytes), {
            ...animationOptions(gif),
            caption: `${hashtagCaption(gif.tags)}\n${gif.id}`.trim(),
            disable_notification: true,
          });
          return this.#remember(gif, msg);
        })
        .finally(() => this.#inFlight.delete(gif.id));
      this.#inFlight.set(gif.id, job);
      // A caller that gave up on this must not turn a failed upload into an unhandled rejection.
      job.catch((err) => this.#log.warn(`could not store ${gif.id} in the storage chat`, err));
    }
    return job;
  }

  /** Get everything needed to send a GIF quickly (downloads it unless Telegram already has it). */
  async prepare(gif: PlayableGif): Promise<Prepared> {
    const fileId = this.#store.get(gif.id);
    if (fileId) return { gif, fileId };
    return { gif, bytes: await this.#client.download(gif.media.mp4.url, this.#maxUploadBytes) };
  }

  /** Send a prepared GIF to a chat as an animation, remembering its `file_id` for next time. */
  async send(chatId: number | string, prepared: Prepared, other: AnimationOptions = {}): Promise<Message> {
    const { gif } = prepared;
    const options = { ...animationOptions(gif), caption: hashtagCaption(gif.tags) || undefined, ...other };

    if ("fileId" in prepared) {
      try {
        return await this.#api.sendAnimation(chatId, prepared.fileId, options);
      } catch (err) {
        if (!isStaleFileIdError(err)) throw err;
        this.#log.warn(`Telegram rejected the cached file id of ${gif.id}; uploading it again`);
        this.#store.delete(gif.id);
        return this.send(chatId, await this.prepare(gif), other);
      }
    }
    const msg = await this.#api.sendAnimation(chatId, this.#file(gif, prepared.bytes), options);
    this.#remember(gif, msg);
    return msg;
  }

  #file(gif: PlayableGif, bytes: Uint8Array): InputFile {
    return new InputFile(bytes, `${gif.id}.mp4`);
  }

  #remember(gif: PlayableGif, msg: Message): string {
    const fileId = msg.animation?.file_id ?? msg.document?.file_id;
    if (!fileId) throw new Error(`Telegram did not return a file for ${gif.id}`);
    this.#store.set(gif.id, fileId);
    return fileId;
  }
}

function animationOptions(gif: PlayableGif): AnimationOptions {
  const { mp4 } = gif.media;
  const options: AnimationOptions = { width: mp4.width, height: mp4.height };
  if (gif.duration_ms) options.duration = Math.max(1, Math.round(gif.duration_ms / 1000));
  return options;
}
