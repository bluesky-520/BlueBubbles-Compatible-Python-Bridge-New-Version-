# BlueBubbles-Compatible Python Bridge

Node.js bridge that exposes BlueBubbles-compatible HTTP and Socket.IO APIs and proxies requests to the local Swift daemon.

## What it does

- **REST API** at `http://localhost:8000/api/v1` — BlueBubbles-style endpoints (server, chats, messages, contacts, handle, FCM)
- **Socket.IO** — real-time events (join/leave chat, message.created, typing, read receipts)
- **Daemon proxy** — talks to Swift daemon at `http://localhost:8081`; subscribes to SSE `/events` and broadcasts to clients
- **Auth** — matches official BlueBubbles: `?password=xxx` or `?guid=xxx` on all API requests

## Requirements

- **Node.js 18+** (ESM)
- **Swift daemon** running (default `http://localhost:8081`). Start the daemon first.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and set `PORT`, `SWIFT_DAEMON_URL`, `SERVER_PASSWORD`, `JWT_SECRET` as needed.

## Configuration

| Variable              | Default                     | Description                |
|-----------------------|-----------------------------|----------------------------|
| `PORT`                | `8000`                      | HTTP server port           |
| `SWIFT_DAEMON_URL`    | `http://localhost:8081`     | Swift daemon base URL      |
| `CORS_ORIGIN`         | `*`                         | CORS allowed origin        |
| `SERVER_PASSWORD`     | (none)                      | Server password (aliases: `PASSWORD`, `SOCKET_PASSWORD`) |
| `JWT_SECRET`          | `your-secret-key-change-this` | Signing key for JWT     |
| `JWT_EXPIRES_IN`      | `7d`                        | Token expiry               |
| `LOG_LEVEL`           | `info`                      | Log level (`debug`, `info`, `warn`, `error`) |
| `LOG_REQUESTS`        | `true`                      | Log HTTP requests (redacts auth query params) |
| `LOG_SOCKET_EVENTS`   | `false`                     | Very verbose Socket.IO event logging |
| `LOG_SSE_HEALTH`      | `true`                      | Log SSE health/polling transitions |
| `LOG_SSE_RECONNECTS`  | `true`                      | Log SSE reconnect attempts |
| `POLL_INTERVAL_MS`    | `1000`                      | Poll Swift daemon when SSE is unhealthy |
| `SSE_IDLE_TIMEOUT_MS` | `5000`                      | Idle time before SSE is considered unhealthy |
| `SSE_WATCHDOG_INTERVAL_MS` | `1000`                | SSE health watchdog interval |
| `ATTACHMENT_DELETE_DELAY_MS` | `600000`           | Delay before deleting temp attachment files |
| `N8N_WEBHOOK_URL`     | (none)                      | Fire-and-forget webhook on send |
| `WEBHOOK_MESSAGE_SENT_URL` | (none)                 | Alias for `N8N_WEBHOOK_URL` |
| `ENCRYPT_COMS` / `ENCRYPT_COMMS` | `false`         | Enable Socket.IO payload encryption |
| `SOCKET_ENCRYPTION_KEY` | (none)                    | Socket.IO encryption key (fallbacks to server password) |
| `NODE_ENV`            | —                           | Kept for compatibility     |

## Run

**Development:**

```bash
npm run dev
```

**Production:**

```bash
npm start
```

## Authentication

**All `/api/v1` routes require authentication** using the server password, matching the official BlueBubbles server.

### Authentication (official BlueBubbles format)

Pass the password as a query parameter on every request:

- `?password=YOUR_SERVER_PASSWORD`
- `?guid=YOUR_SERVER_PASSWORD` (alias)

```bash
curl "http://localhost:8000/api/v1/server/ping?password=mysecret"
curl "http://localhost:8000/api/v1/chats?password=mysecret"
```

### JWT (optional)

You can also use `Authorization: Bearer <token>` for API requests (handy for media downloads):

```bash
curl -H "Authorization: Bearer <token>" "http://localhost:8000/api/v1/attachment/<guid>/download"
```

### Protected Routes

**All routes require authentication** (including server, chat, message, contact, handle, and FCM endpoints). Only `POST /api/v1/auth` is public (for password validation if used).

## HTTP API

Base URL: **`http://localhost:8000/api/v1`**

### Server

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/ping` | `"pong"` | ✅ |
| GET | `/server/ping` | Version, features, timestamp | ✅ |
| GET | `/server/info` | OS, version, helper status | ✅ |
| GET | `/server/permissions` | Placeholder permissions | ✅ |
| POST | `/server/permissions/request` | Placeholder | ✅ |
| GET | `/server/update/check` | Placeholder (no update) | ✅ |
| GET | `/server/statistics/totals` | Placeholder totals | ✅ |
| GET | `/server/statistics/media` | Placeholder media stats | ✅ |
| GET | `/icloud/account` | Placeholder iCloud | ✅ |
| POST | `/auth` | Obtain JWT token | ❌ |

### Chats

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/chats` | List all chats (from daemon) | ✅ |
| GET | `/chats/:chatGuid` | Single chat by GUID | ✅ |
| GET | `/chat` | Alias chat list | ✅ |
| GET | `/chat/:chatGuid` | Single chat | ✅ |
| GET | `/chat/count` | Chat count | ✅ |
| POST | `/chat/new` | Create/find chat by addresses | ✅ |
| POST | `/chat/query` | Query chats (body: `with`, etc.) | ✅ |

**Chat GUID:** Use exact `guid` from `GET /chats`. If the path has `;` or `+`, URL-encode (`%3B`, `%2B`). The bridge encodes the GUID when calling the daemon.

### Messages

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/chat/:chatGuid/message` | Messages for chat. Query: `limit` (1–1000, default 50), `offset`, `before`, `after`, `sort` (ASC/DESC). Returns 404 if chat not found. | ✅ |
| POST | `/message/text` | Send text. Body: `{ chatGuid, text, tempGuid?, attachmentPaths? }` | ✅ |
| POST | `/message/attachment` | Send attachment (multipart `attachment`, body `chatGuid`, `tempGuid?`) | ✅ |
| POST | `/typing-indicator` | Body: `{ chatGuid, isTyping }` | ✅ |
| POST | `/read_receipt` | Body: `{ chatGuid, messageGuids }` | ✅ |
| GET | `/message/count` | Count messages since `after` (Unix ms). Query: `after` | ✅ |

### Attachments

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/attachment/count` | Attachment count | ✅ |
| POST | `/attachment/upload` | Upload file (multipart `attachment`) for later send | ✅ |
| GET | `/attachment/:guid` | Attachment metadata | ✅ |
| GET | `/attachment/:guid/download` | Stream attachment file (supports Range) | ✅ |
| GET | `/attachment/:guid/download/force` | Force download (same stream as download) | ✅ |
| GET | `/attachment/:guid/blurhash` | Unsupported in bridge (returns 404) | ✅ |
| GET | `/attachment/:guid/live` | Unsupported in bridge (returns 404) | ✅ |

### Contacts

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/contacts` | List contacts (from daemon). Query: `limit`, `offset`, `extraProperties` | ✅ |
| GET | `/contacts/vcf` | Contacts as vCard | ✅ |
| GET | `/contact` | Single contact (query) | ✅ |
| GET | `/icloud/contact` | iCloud contact placeholder | ✅ |
| POST | `/contacts/query` | Body: `{ addresses: [...] }` | ✅ |
| POST | `/contact/query` | Contact query | ✅ |

### Handle & FCM

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/handle/availability/imessage` | Placeholder availability | ✅ |
| GET | `/handle/:address/focus` | Placeholder | ✅ |
| GET | `/fcm/client` | FCM client config placeholder | ✅ |
| POST | `/fcm/device` | FCM device placeholder | ✅ |

Responses use envelope format: `{ status, message, data?, metadata?, error? }`.

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health status |
| GET | `/health/sse` | SSE/polling health metrics |

## Socket.IO

**Client → server**

| Event | Payload | Description |
|-------|---------|-------------|
| `join_chat` | `{ chatGuid }` | Join room for chat |
| `leave_chat` | `{ chatGuid }` | Leave room |

**Server → client**

| Event | Description |
|-------|-------------|
| `connection.confirmed` | `{ deviceId }` |
| `message.created` | New message (sent or received) |
| `typing.indicator.started` / `typing.indicator.stopped` | Typing updates |
| `read_receipt` | Read receipt |
| `chat.joined` / `chat.left` | Room confirmation |

The bridge subscribes to the daemon’s `GET /events` SSE and forwards `new_message` (and related) to Socket.IO clients.

## Logs

- `logs/combined.log`
- `logs/error.log`

## Troubleshooting

- **Bridge can’t reach daemon:** Ensure the Swift daemon is running on `http://localhost:8081` (or `SWIFT_DAEMON_URL`). Check startup log: “Swift daemon not reachable” means the daemon is down or wrong URL.
- **Empty messages for a chat:** Use the exact `guid` from `GET /chats` (e.g. `SMS;-;+13108771635`). URL-encode the path if needed.
- **Auth:** Set `SERVER_PASSWORD` and use the same secret across restarts if using JWT.

## Related

- **Swift daemon:** `../BlueBubbles-Daemon` (must be running on port 8081)
- **curl examples:** See workspace `CURL_TEST_COMMANDS.md` for copy-paste API tests
