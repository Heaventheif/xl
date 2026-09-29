# SunkenBot

> A modular Facebook Messenger bot built for Node.js 22.19+, using the pinned `al-fca` client, MQTT session management, MongoDB persistence, media utilities, and resilient HTTP clients.

## Overview

SunkenBot is a production-oriented Messenger bot organized around a small core and a collection of independent commands and utilities.

The project is designed to:

- Keep the Messenger session alive and recover from transient connection problems.
- Load commands dynamically from `cmds/`.
- Persist application state through MongoDB and AppState storage.
- Handle media downloads, splitting, streaming, and temporary-file cleanup.
- Use Axios with connection reuse and retry-aware HTTP handling.
- Keep memory usage bounded in long-running caches and concurrent downloads.
- Run without a web dashboard or HTTP web server.

The application starts from `index.js`.

---

## Requirements

- **Node.js:** `>= 22.19.0` (`al-fca` depends on `undici` 8)
- **npm:** compatible with your Node.js installation
- **MongoDB:** recommended for persistent database-backed features
- A valid **Facebook AppState** for the FCA login flow

Check your Node.js version:

```bash
node --version
npm --version
```

---

## Installation

Clone the repository and install dependencies:

```bash
git clone <YOUR_REPOSITORY_URL>
cd SunkenBot
npm install
```

Start the bot:

```bash
npm start
```

The equivalent command is:

```bash
node index.js
```

---

## Configuration

### Environment variables

Create a `.env` file in the project root when environment-based configuration is required.

Common variables used by the project include:

| Variable | Purpose |
|---|---|
| `APPSTATE` | Facebook AppState used for login |
| `APPSTATE_FILE` | Optional AppState file location |
| `APPSTATE_ENCRYPTION_KEY` | Optional encryption key for persisted AppState |
| `FACEBOOK_EMAIL` | Optional fallback login email |
| `FACEBOOK_PASSWORD` | Optional fallback login password |
| `MONGO_URI` | MongoDB connection URI |
| `MONGODB_URI` | Alternate MongoDB URI variable supported by the project |
| `MONGO_DB_NAME` | MongoDB database name |
| `TZ` | Runtime timezone; the project uses `Europe/Berlin` |
| `HF_SPACE_URL` | Optional Hugging Face service endpoint |
| `HF_API_KEY` | Optional Hugging Face authentication, when required by a provider |
| `TUMBLR_API_KEY` | Optional Tumblr integration key |
| `FERDEV_API_KEY` | Optional external service key |
| `INTERNAL_TOKEN` | Optional token for protected internal functionality |
| `MAX_CONCURRENT_COMMANDS` | Optional command concurrency limit |
| `DEV` | Development/runtime flag |

> Do not commit `.env`, AppState data, cookies, API keys, Facebook email/password, or other secrets to a public repository.

### Example `.env`

```env
APPSTATE='[...]'
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=sunkenbot
TZ=Europe/Berlin
```

Use your real credentials locally. The example above is intentionally incomplete.

---

## Bot configuration

### `config.json`

General bot configuration is stored in `config.json`.

Example structure:

```json
{
  "developers": [],
  "bannedGroups": [],
  "bannedUsers": [],
  "Prefix": [""],
  "botName": "Sunken Bot",
  "dmEnabled": false,
  "groupOnly": true
}
```

Important fields:

- `developers` — privileged developer IDs.
- `bannedGroups` — groups blocked by the bot.
- `bannedUsers` — users blocked by the bot.
- `Prefix` — command prefix configuration.
- `botName` — display name.
- `dmEnabled` — whether direct messages are enabled.
- `groupOnly` — restrict operation to group conversations.

### `fca-config.json`

FCA and session behavior are configured separately.

The bot uses `al-fca@2.0.3` (pinned) through a compatibility adapter so existing commands keep their current method names and callback results.

Important defaults include:

- MQTT watchdog/reconnect managed by the bot (the library's reconnect loop is disabled to avoid competing listeners).
- MQTT watchdog and ping intervals.
- AppState auto-save.
- Session health checks.
- AppState refresh/expiry thresholds.

The project currently uses:

```text
Timezone:              Europe/Berlin
Render HTTP heartbeat: GET /health every 13 minutes (uses RENDER_EXTERNAL_URL; Render only)
Facebook session ping: disabled (previous Facebook keep-alive returned HTTP 400)
MQTT auto-reconnect:   enabled through the bot watchdog only
MQTT watchdog:         enabled
```

AppState persistence and session health checks remain active. The Render heartbeat is a separate GET to the bot's public `/health` endpoint; it does not send cookies or call Facebook. On Render Free, it is a best-effort way to reset the 15-minute idle timer, not a 24/7 uptime guarantee: Render documents a 750 Free instance-hour monthly allowance per workspace, and a continuously running 31-day month uses about 744 hours. Render may restart Free services at any time and says Free instances are not for production. See [Render's Free instance limits](https://render.com/docs/free) and [default environment variables](https://render.com/docs/environment-variables).

The package's automatic npm updater is suppressed so a running Render instance cannot change dependencies and restart itself. Its implicit ImgBB photo re-upload is also disabled to keep incoming photo attachments from being forwarded to a third party.

---

## Architecture

```text
SunkenBot/
├── index.js
├── package.json
├── config.json
├── fca-config.json
│
├── cmds/
│   ├── autodl.js
│   ├── yt.js
│   ├── song.js
│   ├── img.js
│   ├── tts.js
│   ├── tr.js
│   ├── gptx.js
│   ├── gemini.js
│   └── ...
│
├── db/
│   └── index.js
│
└── utils/
    ├── core/
    │   ├── Client.js
    │   ├── Loader.js
    │   └── bot-init.js
    │
    ├── events/
    ├── middleware/
    ├── safety/
    │   └── session-extender.js
    │
    ├── config/
    ├── cache.js
    ├── concurrentDownload.js
    ├── fetchHttp.js
    ├── mediaSplitter.js
    ├── mediaStream.js
    ├── resilience.js
    ├── safeSend.js
    ├── tempCleanup.js
    ├── ytEngine.js
    └── ...
```

### Startup flow

```text
index.js
   │
   ├── Load environment
   ├── Validate configuration
   ├── Load bot configuration
   ├── Connect to MongoDB
   ├── Load commands
   ├── Load AppState
   ├── Login through FCA
   │
   └── Start Messenger/MQTT lifecycle
```

---

## Command system

Commands live under:

```text
cmds/
```

The command loader scans this directory and registers compatible command modules.

This keeps individual features isolated so that adding or updating a command does not require rewriting the application core.

Typical command categories include:

- Media downloading
- YouTube utilities
- Image tools
- Translation
- AI integrations
- Text-to-speech / speech-to-text
- Games
- Group administration
- User utilities
- Manga/comic/novel utilities

To add a command, place the command module in `cmds/` and follow the interface used by the existing commands.

After changing commands during development, the runtime command loader can be triggered through the project's reload mechanism.

---

## HTTP layer

External HTTP requests are centralized around Axios-based utilities.

The project uses:

- Axios
- HTTP/HTTPS keep-alive agents
- Retry handling for transient failures
- Timeout protection
- Response streaming where appropriate
- URL normalization and validation
- SSRF-aware URL checks

This avoids creating unnecessary HTTP clients for every command and allows connection reuse across requests.

### Why Axios?

Axios provides a consistent interface for:

- JSON APIs
- streamed media
- binary responses
- redirects
- request timeouts
- reusable HTTP agents

---

## Session keep-alive

Session management is handled by:

```text
utils/safety/session-extender.js
```

The session extender is responsible for:

- Periodic session keep-alive requests.
- Session health checks.
- AppState refresh/persistence.
- Expiry monitoring.
- Graceful shutdown of timers.
- Reusing HTTP connections.

The keep-alive interval is controlled by:

```json
{
  "session": {
    "keepAliveIntervalMs": 1800000
  }
}
```

`780000 ms` = **13 minutes**.

MQTT recovery is separately handled through the FCA configuration and watchdog.

---

## Database

MongoDB is accessed through the native MongoDB driver.

The database layer is located at:

```text
db/index.js
```

The project does not require SQLite and does not create a local SQLite database.

Set the database connection with:

```env
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=sunkenbot
```

A remote MongoDB deployment can be used by replacing `MONGO_URI` with the appropriate connection string.

---

## Media handling

Media-related utilities are separated from command implementations.

Relevant modules include:

```text
utils/mediaStream.js
utils/mediaSplitter.js
utils/concurrentDownload.js
utils/ytEngine.js
utils/tempCleanup.js
```

They provide:

- Stream-based downloads
- Concurrent-download limits
- Media splitting
- YouTube extraction/download helpers
- Temporary-file cleanup
- Reduced buffering for large media

YouTube downloads intentionally do not impose an additional application-level file-size limit.

---

## Memory and performance

The project includes several protections intended for long-running processes:

### Bounded caches

Frequently used in-memory caches are bounded so that the number of users/threads does not cause unlimited growth.

### Controlled concurrency

Large batches of media are processed with a concurrency limit instead of starting every request simultaneously.

### Stream-based processing

Large HTTP responses are streamed where possible instead of being fully accumulated in memory.

### Temporary-file cleanup

Orphaned temporary media files are cleaned during startup and through the relevant media lifecycle.

### Retry with backoff

Transient connection failures use bounded retries and exponential/backoff-style delays instead of aggressive retry loops.

---

## Reliability

The startup sequence uses retry handling for transient Facebook login failures.

The project also includes:

- MQTT automatic reconnect
- MQTT watchdog
- Session health checks
- AppState persistence
- Temporary-file cleanup
- Graceful shutdown handlers
- Bounded in-memory state
- HTTP timeouts
- Transient-error retry handling

---

## Graceful shutdown

The application listens for:

```text
SIGINT
SIGTERM
```

During shutdown it attempts to:

1. Stop the session lifecycle.
2. Destroy the scheduler.
3. Release the session lock.
4. Exit the process.

This helps prevent stale timers and session resources from remaining active.

---

## Security notes

### Never commit secrets

Do not commit:

```text
.env
AppState
cookies
API keys
MongoDB credentials
private tokens
```

Use environment variables or another secure secret-management mechanism.

### Automatic auth recovery

The bot prefers `APPSTATE`. If Facebook later reports an authentication failure such as `login_blocked`, the MQTT manager stops retry-looping and invokes the auth recovery path. When `FACEBOOK_EMAIL` and `FACEBOOK_PASSWORD` are configured, the bot attempts a fresh login, persists the new AppState, and rebuilds the bot lifecycle. If fallback credentials are unavailable or fail, the manager enters a long cooldown instead of reconnecting repeatedly.

`FACEBOOK_EMAIL` and `FACEBOOK_PASSWORD` are optional secrets. They must be supplied through the environment/secrets store and never committed to the repository.

### AppState

AppState is effectively an authentication credential. Treat it like a password.

If an AppState is exposed publicly, invalidate/replace it.

### HTTP security

The HTTP layer performs URL validation intended to reduce SSRF risk. Do not disable those checks merely to make an external service work.

---

## Development

Run the bot directly:

```bash
node index.js
```

The project also starts a tiny built-in HTTP server for Render health checks. It uses `PORT` when provided (Render sets this automatically) and exposes `/health`. No web framework or extra dependency is required.

Check a JavaScript file:

```bash
node --check path/to/file.js
```

Install dependencies from the lockfile:

```bash
npm ci
```

Install/update dependencies during development:

```bash
npm install
```

---

## Project principles

SunkenBot follows a few practical design principles:

1. **Keep the core small.**
2. **Keep commands independent.**
3. **Reuse HTTP connections.**
4. **Avoid unnecessary buffering.**
5. **Bound long-lived memory structures.**
6. **Limit concurrent expensive operations.**
7. **Persist session state safely.**
8. **Prefer graceful recovery over process crashes.**
9. **Keep security checks in shared utilities.**
10. **Keep the Render health server minimal and dependency-free.**

---

## License

No license is currently declared in `package.json`.

If this project will be published or distributed, add an explicit license file such as:

```text
LICENSE
```

and declare the intended license clearly.

---

## Disclaimer

This project is provided for development and educational use.

Third-party services, APIs, authentication systems, and platform behavior can change independently of this project. Make sure your use of the bot and its integrations complies with the applicable terms and policies of the services you connect to.

---

## Maintainer

**SunkenBot**

For issues and feature requests, use the project's issue tracker or repository discussions.

## مكتبة fca (al-fca المعدّلة)

يستخدم المشروع نسخة معدّلة من al-fca موجودة في `vendor/al-fca` (تُثبَّت عبر `"al-fca": "file:vendor/al-fca"`).
- بلا تحديث تلقائي، وبلا رفع صور إلى جهات خارجية.
- `fca-config.json` يعمل كما هو: `autoReconnect` يبقى `false` ومدير `MqttConnectionManager` هو المسؤول الوحيد عن إعادة الاتصال.
- محاكاة الكتابة والفواصل تبقى في `safeSend.js` و`bot-enhancer.js`؛ خيار `humanize` في المكتبة معطّل افتراضياً حتى لا يتضاعف التأخير.
- بعد نسخ المشروع نفّذ `npm install` مرة واحدة (أو `npm ci`) لتثبيت الاعتماديات.


## Mangalik chapter command

Use `mangalik <manga name> <chapter number>` (alias: `mangalek` or `مانجاليك`) to search Mangalik and send the chapter as image attachments. Each message contains at most 14 images. Downloads are limited to 140 images per request; larger chapters are capped with a warning. Fractional chapters such as `139.2` are supported.

Configure Firecrawl credentials in the **Render service Environment** (never commit keys to Git): set `FIRECRAWL_API` to a comma-separated list of keys, for example `key-one,key-two,key-three`. The bot also accepts the legacy spelling `FIRECRUL_API` and rotates keys for each scrape, trying another key after authentication, credit, rate-limit, or server errors. If the key is missing, the bot replies with a configuration notice. Example: `mangalik SPY×FAMILY 138`.


## Novel and manga scraping

The `novel` command tries its configured reader sources and then the Go bridge; the bridge supports both `Freewebnovel` and `NovelFull`, including fractional chapter numbers resolved from the chapter’s visible label. NovelFull links can encode fractional chapters ambiguously in their URL, so the parser deliberately matches the displayed chapter label instead of URL prefixes.

The `manga` command uses MangaDex with the 3asq bridge as a fallback. MangaDex chapter matches are exact; page URLs use the server-provided at-home base URL and HTTPS. Chapter image delivery uses groups of at most **14 images**, with a 300-page chapter cap and a 16 MiB per-image cap. The unsupported `cc`/CodeCraft command has been removed.
