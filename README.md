# unigif-bot

A Telegram bot for a [Unigif](https://github.com/TimurSl/unigif) server. It searches your GIF library by hashtag and sends any GIF, either **inline in any chat** (`@yourbot cat funny`) or **in a private chat with the bot**.

It only reads from Unigif, through the HTTP API, with a key that needs just the `read` scope. It never writes to your library.

## What it does

**Inline mode.** In any chat on any Telegram client, type the bot's name and some hashtags, then tap a GIF to send it:

```
@yourbot cat funny      GIFs tagged both #cat and #funny
@yourbot cat -dog       tagged #cat, not #dog
@yourbot ca             while you're still typing, the last word matches as a prefix (#cat, #car…)
@yourbot                nothing typed: your most used GIFs
```

Results scroll (30 at a time) and load more as you scroll. Each GIF you send counts as a use in Unigif, so your favourites float to the top.

**In a chat with the bot.** Send hashtags as a normal message and it replies with the matching GIFs (5 at a time, each captioned with its hashtags), with a **More ▸** button for the next batch.

| Message | Result |
|---|---|
| `cat funny` | GIFs with both hashtags (the whole word, so `cat` does not match `#catnap`) |
| `/gif cat -dog` | same, written as a command |
| `/gif` | your most used GIFs |
| `/tags` | the most used hashtags as buttons; tap one to see its GIFs |
| `/tags ca` | hashtags starting with `ca` |
| `/help` | what the bot can do |

## Set it up

You need a running Unigif server that Telegram's servers can reach over HTTPS for inline mode (its `publicUrl`), and Node.js 22 or Docker.

**1. Create the bot** with [@BotFather](https://t.me/BotFather): `/newbot`. Then, for the same bot:

- `/setinline` and give it a placeholder such as `hashtags, like: cat funny`. Without this, inline mode stays off.
- `/setinlinefeedback` and choose `Enabled` (or a percentage). Without this, the bot never hears which GIF you picked, so inline sends don't count towards "most used".

**2. Create a Unigif key** for it: in Unigif under **Keys** choose the *Read-only* preset, or

```bash
unigif key create --name telegram --preset read_only
```

A key can hide hashtags (`deny_tags`), so a key that hides `#private` keeps those GIFs out of Telegram too.

**3. (Recommended) Make a storage chat.** Telegram only takes inline results by URL for small files (its documentation says about 1 MB). Bigger GIFs are uploaded to Telegram once, and from then on are answered instantly from the `file_id` Telegram hands back. The bot needs somewhere to upload to: create a **private channel** and add the bot as an administrator. The channel's id looks like `-1001234567890`; to find it, post any message in the channel, then open `https://api.telegram.org/bot<your token>/getUpdates` and read `chat.id` from the `channel_post` entry. Without a storage chat, a GIF over the limit is offered as its smaller preview version in inline mode. In-chat sending is not affected, and it also fills the same cache.

**4. Configure and run.** Copy `.env.example` to `.env` and fill it in. At minimum:

```ini
TELEGRAM_BOT_TOKEN=123456:ABC…
UNIGIF_URL=https://gif.example.com
UNIGIF_API_KEY=ugf_…
ALLOWED_USER_IDS=123456789
STORAGE_CHAT_ID=-1001234567890
```

Don't know your Telegram user id? Put a placeholder (`ALLOWED_USER_IDS=1`), start the bot and message it. It replies that it is private and tells you your id; put that in `ALLOWED_USER_IDS` and restart.

With Docker:

```bash
docker compose up -d
```

Or with Node:

```bash
npm ci && npm run build
node --env-file=.env dist/index.js
```

On start the bot checks that Unigif and Telegram accept it, and warns about anything that will make it less useful (inline mode off, no storage chat, open to everybody).

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | Bot token from @BotFather |
| `UNIGIF_URL` | required | Base URL of the Unigif server |
| `UNIGIF_API_KEY` | required | Unigif key with the `read` scope |
| `ALLOWED_USER_IDS` | required* | Telegram user ids allowed to use the bot, comma separated |
| `ALLOW_ANYONE` | off | `true` instead of `ALLOWED_USER_IDS`: anybody can search your library |
| `STORAGE_CHAT_ID` | none | Private chat or channel for one-time uploads (see step 3) |
| `DATA_DIR` | `./data` | Holds `file-ids.json`, the cache of Telegram file ids |
| `SORT` | `used` | Order of results: `used` (most used first), `new` or `old` |
| `INLINE_PAGE_SIZE` | `30` | Results per inline page (1–50) |
| `CHAT_PAGE_SIZE` | `5` | GIFs per search in a chat (1–10) |
| `INLINE_URL_MAX_BYTES` | `1000000` | Largest MP4 given to Telegram as a URL |
| `MAX_UPLOAD_BYTES` | `20000000` | Largest MP4 the bot downloads from Unigif to upload |
| `INLINE_UPLOAD_BUDGET_MS` | `4000` | How long an inline query waits for uploads before answering with what's ready |
| `INLINE_CACHE_SECS` | `30` | How long Telegram may cache an inline answer |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

\* One of `ALLOWED_USER_IDS` or `ALLOW_ANYONE=true` must be set; the bot refuses to start otherwise.

## How it works

- **Search** is `GET /api/v1/gifs?q=…&status=ready` on the Unigif API. The bot cleans what you type (`#Cat, funny!` becomes `cat funny`) and the server does the matching.
- **Sending** uses the stored `full.mp4` of each GIF. Unigif keeps GIFs as H.264 MP4s without audio, which is the format Telegram uses for its own GIFs, so they play as GIFs.
- **The `file_id` cache** (`DATA_DIR/file-ids.json`) maps a Unigif GIF id to the Telegram file. It is safe to delete (GIFs are just uploaded again) and is ignored if the bot token changes. A `file_id` Telegram no longer accepts is dropped and the GIF uploaded again, rather than failing the search.
- **Media is fetched from `UNIGIF_URL`**, even though Unigif writes its public address into media links, so the bot can run next to the server on an internal address. The key is sent only to that server.
- **Access:** only `ALLOWED_USER_IDS` can use the bot, in private chats and inline. Anyone else is told it's private and gets their user id, so you can add them. The bot ignores group messages.

## Things to know

- Inline mode needs Telegram to be able to fetch `publicUrl` media. If Unigif runs with `media.public = false`, URL results can't work; set a storage chat so every inline GIF is served from Telegram's own copy.
- A GIF still being converted (`status: processing`) is not offered until it's ready.
- The bot uses long polling, so it needs no public address of its own and no webhook.
- The 1 MB limit for inline URLs comes from Telegram's Bot API documentation as described in Unigif's `PLAN.md`, which marks it *(verify)*. If Telegram accepts more in practice, raise `INLINE_URL_MAX_BYTES`.

## Development

```bash
npm ci
npm run typecheck
npm test               # unit and handler tests; Telegram and Unigif are faked
npm run dev            # restart on change, reads .env
```

The end-to-end tests run the real Unigif server and real ffmpeg, with only Telegram faked. They are skipped unless you point them at the binary:

```bash
(cd ../unigif && cargo build)
UNIGIF_BIN=../unigif/target/debug/unigif npm test
```

## Licence

[MIT](LICENSE)
