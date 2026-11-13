/** A small client for the parts of the Unigif HTTP API (v1) this bot uses. */

export interface MediaFile {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export interface Gif {
  id: string;
  status: "processing" | "ready" | "failed";
  tags: string[];
  description: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_url: string;
  media: {
    mp4: MediaFile | null;
    preview_mp4: MediaFile | null;
    poster: MediaFile | null;
  } | null;
}

/** A GIF that is ready and has its stored MP4. */
export type PlayableGif = Gif & { media: { mp4: MediaFile; preview_mp4: MediaFile | null; poster: MediaFile | null } };

export interface Tag {
  name: string;
  gif_count: number;
  last_used_at: string | null;
}

export interface Me {
  kind: "user" | "key";
  name: string;
  scopes: string[];
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type Sort = "new" | "old" | "used";

export class UnigifError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the server could not be reached. */
    readonly status: number,
    /** The API's stable error code, or `network` / `timeout`. */
    readonly code: string,
    /** Seconds to wait before retrying, from `Retry-After`. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "UnigifError";
  }
}

export function isPlayable(gif: Gif): gif is PlayableGif {
  return gif.status === "ready" && gif.media?.mp4 != null;
}

export interface UnigifClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout for API calls, in ms. */
  timeoutMs?: number;
}

export class UnigifClient {
  readonly #base: string;
  readonly #origin: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: UnigifClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#origin = new URL(this.#base).origin;
    this.#key = opts.apiKey;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async me(): Promise<Me> {
    return this.#json<Me>("GET", "/me");
  }

  /**
   * Search the library. `q` is the hashtag query (`cat funny -dog`). The server treats the last word as a
   * prefix while it is still being typed; `exact` ends the query with a space so it is matched whole.
   * Only GIFs that are ready to play come back.
   */
  async searchGifs(opts: {
    q?: string;
    sort: Sort;
    limit: number;
    cursor?: string | null;
    exact?: boolean;
  }): Promise<Page<PlayableGif>> {
    const query: Record<string, string> = {
      status: "ready",
      sort: opts.sort,
      limit: String(opts.limit),
    };
    const q = opts.q ?? "";
    if (q.trim()) query["q"] = opts.exact ? `${q.trim()} ` : q;
    if (opts.cursor) query["cursor"] = opts.cursor;
    const page = await this.#json<Page<Gif>>("GET", "/gifs", query);
    return { items: page.items.filter(isPlayable), next_cursor: page.next_cursor };
  }

  async listTags(opts: { q?: string; sort: "recent" | "popular" | "alpha"; limit: number }): Promise<Tag[]> {
    const query: Record<string, string> = { sort: opts.sort, limit: String(opts.limit) };
    if (opts.q) query["q"] = opts.q;
    const page = await this.#json<Page<Tag>>("GET", "/tags", query);
    return page.items;
  }

  /** Usage ping: the GIF was posted. Feeds the "most used" ordering. */
  async markUsed(id: string): Promise<void> {
    await this.#request("POST", `/gifs/${encodeURIComponent(id)}/use`);
  }

  /**
   * Where the bot itself fetches a media URL from. The server builds media URLs from its `publicUrl`, which
   * a bot on the same machine or network may not be able (or want) to reach, so `/m/…` paths are resolved
   * against the configured base URL instead.
   */
  mediaUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url, this.#base);
    } catch {
      throw new UnigifError(`invalid media URL ${JSON.stringify(url)}`, 0, "bad_media_url");
    }
    if (parsed.pathname.startsWith("/m/")) return `${this.#base}${parsed.pathname}${parsed.search}`;
    return parsed.toString();
  }

  /** Download a media file, refusing anything larger than `maxBytes`. */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const target = this.mediaUrl(url);
    // The key only ever goes to the Unigif server itself, never to another host a URL might point at.
    const headers: Record<string, string> = {};
    if (new URL(target).origin === this.#origin) headers["Authorization"] = `Bearer ${this.#key}`;

    const res = await this.#send("GET", target, headers, 60_000);
    if (!res.ok) throw await this.#errorFrom(res);

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      throw new UnigifError(`media is ${declared} bytes, over the ${maxBytes} byte limit`, 413, "too_large");
    }
    if (!res.body) return new Uint8Array(await res.arrayBuffer());

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new UnigifError(`media is over the ${maxBytes} byte limit`, 413, "too_large");
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof UnigifError) throw err;
      throw new UnigifError(`download failed: ${errorMessage(err)}`, 0, "network");
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  async #json<T>(method: string, path: string, query?: Record<string, string>): Promise<T> {
    const res = await this.#request(method, path, query);
    try {
      return (await res.json()) as T;
    } catch {
      throw new UnigifError("the server sent a response that is not JSON", res.status, "bad_response");
    }
  }

  async #request(method: string, path: string, query?: Record<string, string>): Promise<Response> {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : "";
    const res = await this.#send(
      method,
      `${this.#base}/api/v1${path}${qs}`,
      { Authorization: `Bearer ${this.#key}`, Accept: "application/json" },
      this.#timeoutMs,
    );
    if (!res.ok) throw await this.#errorFrom(res);
    return res;
  }

  async #send(method: string, url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    try {
      return await this.#fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new UnigifError(
        timedOut ? "the Unigif server did not answer in time" : `cannot reach the Unigif server: ${errorMessage(err)}`,
        0,
        timedOut ? "timeout" : "network",
      );
    }
  }

  async #errorFrom(res: Response): Promise<UnigifError> {
    let detail = res.statusText || `HTTP ${res.status}`;
    let code = "http_error";
    try {
      const body = (await res.json()) as { detail?: string; code?: string };
      if (body.detail) detail = body.detail;
      if (body.code) code = body.code;
    } catch {
      // not a problem+json body; keep the status text
    }
    const retry = Number(res.headers.get("retry-after"));
    return new UnigifError(detail, res.status, code, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}
