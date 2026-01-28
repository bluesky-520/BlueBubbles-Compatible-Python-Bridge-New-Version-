# BlueBubbles-Compatible Python Bridge

Node.js bridge that exposes BlueBubbles-compatible HTTP and Socket.IO APIs and
proxies data to the local Swift daemon.

## What it does

- Exposes BlueBubbles-style REST endpoints on `http://localhost:8000`.
- Manages Socket.IO connections and chat rooms.
- Polls the Swift daemon for updates and broadcasts them to clients.
- Translates Swift daemon responses into BlueBubbles-compatible shapes.

## Requirements

- Node.js 18+ (ESM modules).
- Swift daemon running locally (default `http://localhost:8081`).

## Setup

```
npm install
```

## Configuration

Environment variables:

- `PORT` (default `8000`)
- `CORS_ORIGIN` (default `*`)
- `SWIFT_DAEMON_URL` (default `http://localhost:8081`)
- `JWT_SECRET` (default `your-secret-key-change-this`)
- `JWT_EXPIRES_IN` (default `7d`)
- `NODE_ENV` (`production` lowers log level)

## Run

Development:

```
npm run dev
```

Production:

```
npm start
```

## Auth flow

1. `POST /api/v1/auth` with `{ "password": "..." }`
2. Receive `{ access_token, token_type }`
3. Use `Authorization: Bearer <token>` for protected routes

Note: `validatePassword()` currently accepts any non-empty password. Replace it
with real validation before production use.

## HTTP API

Server:

- `GET /api/v1/server/ping`
- `GET /api/v1/server/info`

Chats:

- `GET /api/v1/chats`
- `GET /api/v1/chats/:chatGuid`

Messages:

- `GET /api/v1/chats/:chatGuid/messages?limit=50&before=TIMESTAMP`
- `POST /api/v1/message/text`
- `POST /api/v1/typing-indicator`
- `POST /api/v1/read_receipt`

## Socket.IO

Client events:

- `join_chat` `{ chatGuid }`
- `leave_chat` `{ chatGuid }`

Server events:

- `connection.confirmed` `{ deviceId }`
- `message.created` (new message payload)
- `typing.indicator.started` / `typing.indicator.stopped`
- `read_receipt`
- `chat.joined` / `chat.left`

## Logs

Logs are written to:

- `logs/combined.log`
- `logs/error.log`

## Troubleshooting

- Verify the Swift daemon is running on `http://localhost:8081`.
- Check `logs/error.log` for daemon connection issues.
- Confirm `JWT_SECRET` is set consistently across deployments.
