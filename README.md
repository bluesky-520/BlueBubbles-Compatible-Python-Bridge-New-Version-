# BlueBubbles-Compatible Python Bridge

Node.js bridge that exposes BlueBubbles-compatible HTTP and Socket.IO APIs and proxies requests to the local Swift daemon.

## What it does

- **REST API** at `http://localhost:8000/api/v1` — BlueBubbles-style endpoints (server, chats, messages, contacts, handle, FCM)
- **Socket.IO** — real-time events (join/leave chat, message.created, typing, read receipts)
- **Daemon proxy** — talks to Swift daemon at `http://localhost:8081`; subscribes to SSE `/events` and broadcasts to clients
- **Auth** — optional JWT; `POST /api/v1/auth` with password, then `?token=...` or `Authorization: Bearer <token>`

## Requirements

- **Node.js 18+** (ESM)
- **Swift daemon** running (default `http://localhost:8081`). Start the daemon first.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and set `PORT`, `SWIFT_DAEMON_URL`, `SERVER_PASSWORD`, `JWT_SECRET` as needed.

## Configuration

| Variable           | Default                     | Description                |
|--------------------|-----------------------------|----------------------------|
| `PORT`             | `8000`                      | HTTP server port           |
| `SWIFT_DAEMON_URL` | `http://localhost:8081`     | Swift daemon base URL      |
| `CORS_ORIGIN`      | `*`                         | CORS allowed origin        |
| `SERVER_PASSWORD`  | (none)                      | Password for `POST /api/v1/auth` |
| `JWT_SECRET`       | `your-secret-key-change-this` | Signing key for JWT     |
| `JWT_EXPIRES_IN`   | `7d`                        | Token expiry               |
| `NODE_ENV`         | —                           | `production` lowers logs   |

## Run

**Development:**

```bash
npm run dev
```

**Production:**

```bash
npm start
```

## Auth

1. `POST /api/v1/auth` with `{ "password": "..." }` (if `SERVER_PASSWORD` is set).
2. Response: `{ "data": { "access_token", "token_type": "Bearer" } }`.
3. Use `?token=<token>` in query or `Authorization: Bearer <token>` on protected routes.

Most routes use **optional** auth: they work without a token but accept one when provided.

## HTTP API

Base URL: **`http://localhost:8000/api/v1`**

### Server

| Method | Path | Description |
|--------|------|-------------|
| GET | `/ping` | `"pong"` |
| GET | `/server/ping` | Version, features, timestamp |
| GET | `/server/info` | OS, version, helper status |
| GET | `/server/permissions` | Placeholder permissions |
| POST | `/server/permissions/request` | Placeholder |
| GET | `/server/update/check` | Placeholder (no update) |
| GET | `/server/statistics/totals` | Placeholder totals |
| GET | `/server/statistics/media` | Placeholder media stats |
| GET | `/icloud/account` | Placeholder iCloud |

### Chats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/chats` | List all chats (from daemon) |
| GET | `/chats/:chatGuid` | Single chat by GUID |
| GET | `/chat` | Alias chat list |
| GET | `/chat/:chatGuid` | Single chat |
| GET | `/chat/count` | Chat count |
| POST | `/chat/new` | Create/find chat by addresses |
| POST | `/chat/query` | Query chats (body: `with`, etc.) |

**Chat GUID:** Use exact `guid` from `GET /chats`. If the path has `;` or `+`, URL-encode (`%3B`, `%2B`). The bridge encodes the GUID when calling the daemon.

### Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/chat/:chatGuid/message` | Messages for chat. Query: `limit` (1–1000, default 50), `offset`, `before`, `after`, `sort` (ASC/DESC). Returns 404 if chat not found. |
| POST | `/message/text` | Send text. Body: `{ chatGuid, text, tempGuid?, attachmentPaths? }` |
| GET | `/message/count` | Message count. Query: `chatGuid` |
| GET | `/attachment/:guid` | Stream attachment by GUID |
| POST | `/typing-indicator` | Body: `{ chatGuid, isTyping }` |
| POST | `/read_receipt` | Body: `{ chatGuid, messageGuids }` |

### Contacts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/contacts` | List contacts (from daemon). Query: `limit`, `offset`, `extraProperties` |
| GET | `/contacts/vcf` | Contacts as vCard |
| GET | `/contact` | Single contact (query) |
| GET | `/icloud/contact` | iCloud contact placeholder |
| POST | `/contacts/query` | Body: `{ address }` etc. |
| POST | `/contact/query` | Contact query |

### Handle & FCM

| Method | Path | Description |
|--------|------|-------------|
| GET | `/handle/availability/imessage` | Placeholder availability |
| GET | `/handle/:address/focus` | Placeholder |
| GET | `/fcm/client` | FCM client config placeholder |
| POST | `/fcm/device` | FCM device placeholder |

Responses use envelope format: `{ status, message, data?, metadata?, error? }`.

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
