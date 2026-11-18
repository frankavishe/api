# Chat App — API

NestJS 12 backend for the Chat App messenger: phone sign-in with one-time codes, devices,
profiles, contacts and the realtime channel. PostgreSQL 16 (`postgres:16-trixie`), Redis, and
S3-compatible storage (MinIO in development).

Specs and plans live in the Spec Kit repo one level up (`../specs/`).

## Requirements

- Node.js 24, npm
- Docker Desktop (for the local services and the e2e tests)

## Run locally

```bash
cp .env.example .env
docker compose up -d          # postgres:16-trixie (port 5433), redis (6380), minio (9000/9001)
npm install
npx prisma migrate dev        # creates tables and generates the Prisma client
npm run start:dev             # http://localhost:3000/v1
```

One-time codes are printed in the log as `OTP for +255…: 123456`. In development the latest code
is also available at `GET /v1/dev/last-otp?phone=%2B255…` (this route does not exist in other
environments, and the log-based sender is refused when `NODE_ENV=production`).

To run the API itself in Docker too: `docker compose --profile full up --build`.

## Tests

```bash
npm test              # unit tests (Vitest)
npm run test:e2e      # e2e: starts postgres:16-trixie, redis and minio with Testcontainers
npm run typecheck
npm run lint          # oxlint (needs its native binary to be allowed on this machine)
```

e2e responses are validated against `contracts/openapi.yaml`.

## Contract

`contracts/openapi.yaml` (REST) and `contracts/ws-events.schema.json` (Socket.IO namespace `/rt`)
are the source of truth for the web and mobile clients. Change the contract first, then the code,
then regenerate client types (`npm run gen:api` in the web repo).

## Layout

```
src/
  auth/        request-code, verify, refresh, sign-out; OTP, sessions, SMS sender, cleanup job
  devices/     device list/sign-out, device limits, cached device status
  users/       /me, avatars
  contacts/    discovery and lookup
  realtime/    Socket.IO gateway, Redis adapter, typed event emitters
  storage/     S3/MinIO client
  common/      errors, auth guard, rate limiting, phone numbers
prisma/        schema and migrations
contracts/     OpenAPI + WebSocket event schema
test/          e2e tests and Testcontainers setup
```
