# SunkenBot

> A modular Facebook Messenger bot built for Node.js 20+, with FCA/MQTT session management, MongoDB persistence, media utilities, resilient HTTP clients, and a large command/event ecosystem.

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

- **Node.js:** `>= 20`
- **npm:** compatible with your Node.js installation
- **MongoDB:** recommended for persistent AppState and bot data across restarts/deploys
- A valid **Facebook AppState** for the FCA login flow, or `FACEBOOK_EMAIL` + `FACEBOOK_PASSWORD` as automatic fallback

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
| `APPSTATE_FILE` | AppState bootstrap/persistence file; defaults to `appstate.json` |
| `APPSTATE_WRITE_FILE` | Write the refreshed AppState back to `APPSTATE_FILE` (`true` by default) |
| `APPSTATE_PERSIST_FILE` | Optional encrypted local backup file; defaults to `.appstate.enc` |
| `APPSTATE_ENCRYPTION_KEY` | Encryption key required for encrypted local/Mongo AppState persistence |
| `FACEBOOK_EMAIL` | Optional fallback login email |
| `FACEBOOK_PASSWORD` | Optional fallback login password |
| `FACEBOOK_2FA` | Optional Base32 TOTP secret; code is generated locally |
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
APPSTATE_FILE=appstate.json
APPSTATE_WRITE_FILE=true
APPSTATE_PERSIST_FILE=.appstate.enc
APPSTATE_ENCRYPTION_KEY=<long-random-secret>
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=sunkenbot
TZ=Europe/Berlin
FACEBOOK_EMAIL=
FACEBOOK_PASSWORD=
FACEBOOK_2FA=
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

Important defaults include:

- Automatic MQTT reconnect.
- MQTT watchdog and ping intervals.
- AppState auto-save.
- Session keep-alive.
- Session health checks.
- AppState refresh/expiry thresholds.

The project currently uses:

```text
Timezone:              Europe/Berlin
Session keep-alive:    13 minutes
MQTT auto-reconnect:   enabled
MQTT watchdog:         enabled
```

The keep-alive implementation uses an HTTP agent with connection reuse and consumes the response as a stream, avoiding unnecessary response buffering.

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

## AppState persistence and session longevity

The active session is kept in the live FCA CookieJar and persisted when it actually changes:

```text
APPSTATE / appstate.json
        │
        ├── live CookieJar
        ├── appstate.json (direct persistence)
        ├── .appstate.enc (encrypted local backup)
        └── MongoDB bot_appstate (encrypted backup when configured)
```

A successful credential login uses `FACEBOOK_EMAIL`, `FACEBOOK_PASSWORD`, and the local `FACEBOOK_2FA` Base32 TOTP secret when Facebook requests 2FA. Refreshed cookies are saved automatically, so the operator does not need to manually replace AppState after every successful refresh. Cookie expiration dates are not artificially extended; the bot only persists values actually present in Facebook's authenticated CookieJar.

For persistent deployments, configure MongoDB together with `APPSTATE_ENCRYPTION_KEY`. Keep `appstate.json` and `.appstate.enc` out of Git.

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

`fca-nx` no longer depends on Sequelize or SQLite. Its user/thread layer is a bounded in-memory cache because Facebook can be queried again for this metadata; MongoDB is reserved for durable SunkenBot state such as bans and encrypted AppState. This removes a native SQLite build dependency and avoids maintaining two competing persistent databases.

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


## تسجيل الدخول وتجديد AppState

يمكن تشغيل الدخول الاحتياطي محليًا عبر `FACEBOOK_EMAIL` و`FACEBOOK_PASSWORD`.
إذا كان الحساب يستخدم تطبيق مصادقة TOTP، ضع المفتاح السري Base32 في `FACEBOOK_2FA` أو `FB_2FA`.
المشروع يستخدم `totp-generator` محليًا لإنشاء رمز TOTP؛ لا يحتاج مولد الرمز إلى خادم أو API خارجي.

```env
FACEBOOK_EMAIL=your@email.com
FACEBOOK_PASSWORD=your-password
FACEBOOK_2FA=BASE32_TOTP_SECRET
```

عند نجاح تسجيل الدخول يتم استخراج AppState من Cookie Jar المحلي وحفظه عبر نظام AppState الموجود في المشروع.
لا تضع كلمة السر أو مفتاح TOTP داخل Git.
