/**
 * Remembers the Telegram `file_id` of every GIF the bot has uploaded, so it is uploaded once and then
 * answered from Telegram's own storage. A `file_id` only works for the bot that received it, so the file
 * records the bot's id and is discarded if the token ever points to another bot.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "./util.js";

interface StoreFile {
  version: 1;
  botId: number;
  files: Record<string, string>;
}

export class FileIdStore {
  readonly #path: string;
  readonly #botId: number;
  readonly #log: Logger;
  #files = new Map<string, string>();
  #dirty = false;
  #timer: NodeJS.Timeout | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string, botId: number, log: Logger) {
    this.#path = join(dataDir, "file-ids.json");
    this.#botId = botId;
    this.#log = log;
  }

  get size(): number {
    return this.#files.size;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      const data = JSON.parse(text) as StoreFile;
      if (data.version !== 1 || typeof data.files !== "object" || data.files === null) throw new Error("shape");
      if (data.botId !== this.#botId) {
        this.#log.warn("file-id cache belongs to another bot; starting empty");
        return;
      }
      this.#files = new Map(Object.entries(data.files).filter(([, v]) => typeof v === "string"));
    } catch {
      const backup = `${this.#path}.corrupt`;
      this.#log.warn(`file-id cache is unreadable; moving it to ${backup} and starting empty`);
      await rename(this.#path, backup).catch(() => {});
    }
  }

  get(gifId: string): string | undefined {
    return this.#files.get(gifId);
  }

  set(gifId: string, fileId: string): void {
    if (this.#files.get(gifId) === fileId) return;
    this.#files.set(gifId, fileId);
    this.#schedule();
  }

  delete(gifId: string): void {
    if (this.#files.delete(gifId)) this.#schedule();
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#writing = this.#writing.then(() => this.#write());
    await this.#writing;
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch((err) => this.#log.error("could not save the file-id cache", err));
    }, 1000);
    this.#timer.unref();
  }

  async #write(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    const data: StoreFile = { version: 1, botId: this.#botId, files: Object.fromEntries(this.#files) };
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, this.#path);
  }
}
