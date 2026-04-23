# Telegraph Chat

Telegraph Chat is a Dockerized Telegram-like chat demo built with Nginx, Node.js, WebSockets, RabbitMQ, Redis, PostgreSQL, and MinIO. The stack is designed to run locally with one command and show a working browser-based chat experience.

## Features

- JWT authentication with register and login flows
- REST APIs for rooms, messages, history, uploads, and user search
- WebSocket real-time delivery, typing indicators, presence updates, and read receipts
- RabbitMQ fan-out between the message and connection services
- Redis-backed presence and typing TTL state
- PostgreSQL persistence with seeded demo users and a `General` room
- MinIO-backed media upload URLs
- Telegram-style single-file frontend served by Nginx

## Running Instructions

1. Start Docker Desktop and wait until Docker is fully running.
2. Open a terminal in the project folder:

```bash
cd "/Users/main/Desktop/chatting application "
```

3. Create the environment file if you do not already have one:

```bash
cp .env.example .env
```

4. Build and start the full stack:

```bash
docker-compose up --build
```

If your machine uses the newer Docker CLI, this works too:

```bash
docker compose up --build
```

5. When the containers are up, open these URLs:

- App: http://localhost
- Message service health: http://localhost/health
- RabbitMQ UI: http://localhost:15672
- MinIO Console: http://localhost:9001

6. Log in with any seeded demo user:

- `alice` / `password123`
- `bob` / `password123`
- `charlie` / `password123`

7. Test the chat:

- open `http://localhost` in two browser tabs
- log in as `alice` in one tab and `bob` in the other
- open the `General` room
- send messages and confirm they appear in real time

### Stop The Stack

```bash
docker-compose down
```

### Reset The Database And Start Fresh

```bash
docker-compose down -v
docker-compose up --build
```

## Services

- `nginx`: serves the frontend and proxies `/api` and `/ws`
- `auth`: handles `/api/auth/register`, `/api/auth/login`, and `/health`
- `message`: handles rooms, history, uploads, search, status updates, and RabbitMQ publish
- `connection`: handles WebSocket auth, joins, presence, typing, reads, RabbitMQ consume, and fan-out
- `postgres`: stores users, rooms, memberships, and messages
- `redis`: stores presence and typing TTL state
- `rabbitmq`: transports async room delivery events
- `minio`: stores uploaded media

## API Summary

Auth:

- `POST /api/auth/register`
- `POST /api/auth/login`

Message service:

- `GET /api/rooms`
- `POST /api/rooms`
- `GET /api/rooms/:id/messages?limit=50&before=<message_id>`
- `POST /api/messages`
- `PATCH /api/messages/:id/status`
- `POST /api/upload`
- `GET /api/users/search?q=<query>`
- `GET /health`

WebSocket client events:

```json
{ "type": "auth", "token": "<jwt>" }
{ "type": "join", "roomId": "<uuid>" }
{ "type": "message", "roomId": "<uuid>", "content": "Hello!" }
{ "type": "typing", "roomId": "<uuid>", "isTyping": true }
{ "type": "read", "roomId": "<uuid>", "messageId": "<uuid>" }
{ "type": "ping" }
```

WebSocket server events:

```json
{ "type": "message", "id": "<uuid>", "roomId": "<uuid>", "senderId": "<uuid>", "senderName": "alice", "content": "Hello!", "createdAt": "<iso>" }
{ "type": "typing", "roomId": "<uuid>", "userId": "<uuid>", "username": "alice", "isTyping": true }
{ "type": "presence", "userId": "<uuid>", "username": "alice", "status": "online" }
{ "type": "read", "roomId": "<uuid>", "userId": "<uuid>", "messageId": "<uuid>", "status": "read" }
{ "type": "error", "message": "Not authorized" }
```

## Notes

- All services log with timestamped service prefixes.
- RabbitMQ uses the durable `chat.messages` topic exchange and `room.<room_id>` routing keys.
- The connection service consumes from `ws-delivery-<instance_id>` queues for scale-friendly fan-out.
- Uploads are limited to 10MB and validated against an allowlist of MIME types.


app flow descripbed in diagram in the root of the project 