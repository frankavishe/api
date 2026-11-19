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
environments, and the log-based sender is refused when `NODE_ENV=production` unless
`ALLOW_LOG_SMS=true` is set for a staging deploy).

To run the API itself in Docker too: `docker compose --profile full up --build`.

## Tests

```bash
npm test              # unit tests (Vitest)
npm run test:e2e      # e2e: starts postgres:16-trixie, redis and minio with Testcontainers
npm run typecheck
npm run lint          # oxlint (needs its native binary to be allowed on this machine)
```

e2e responses are validated against `contracts/openapi.yaml`.

## Deploy to Render (free-tier staging)

`render.yaml` is a Render Blueprint that creates everything in one region (`frankfurt`):

| Service      | Type                     | Notes                                                      |
| ------------ | ------------------------ | ---------------------------------------------------------- |
| `chat-db`    | Postgres (free)          | **Expires after 30 days** on the free plan                 |
| `chat-redis` | Key Value (free)         | Internal only                                              |
| `chat-api`   | Web service, Docker      | Runs `prisma migrate deploy` on start; health `/v1/health` |
| `chat-web`   | Web service, Node        | From the `web` repo; proxies `/v1/*` to the API            |

Free web services sleep after 15 minutes idle, so the first request takes about a minute.

**Staging mode:** `ALLOW_LOG_SMS=true`, so no SMS is sent. Read the code from the
**chat-api → Logs** tab (`OTP for +255…: 123456`). Don't give this deploy to real users.

### Steps

1. **AWS S3** (avatars):
   - In S3, create a bucket (ours: `chat-avatars-frankavishe` in **`eu-north-1`**). Any region
     works, but `S3_REGION` and `S3_BUCKET_AVATARS` in `render.yaml` must match the bucket.
     Bucket names are global, so pick a unique one such as `chat-avatars-<something>`.
     Keep **Block all public access** on: avatars are served through the API
     (`GET /v1/avatars/:key`), never directly from S3.
   - In IAM, create a user `chat-api-render` with no console access, and attach this inline policy:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::<your-bucket>/*"
       }]
     }
     ```
   - Under **Security credentials → Create access key → Application running outside AWS**, copy
     the Access key ID and the Secret access key. The secret is shown only once.
   - `S3_ENDPOINT` is **not** set for AWS: the SDK uses the regional endpoint for `S3_REGION`.
2. Push this repo and the `web` repo. Render deploys branch `001-foundation-auth`; change
   `branch:` in `render.yaml` when you merge.
3. In Render, go to **New → Blueprint**, pick this repo, and allow Render access to the `web`
   repo too. When it asks for the `sync: false` values, enter `S3_ACCESS_KEY` and
   `S3_SECRET_KEY` from step 1 (never commit them). For the
   URL values, enter `https://chat-api.onrender.com` and `https://chat-web.onrender.com` as
   placeholders for now.
4. After the first deploy, open each service, copy its real `*.onrender.com` URL, and set the
   values below. **Don't skip this step.** These names are usually taken, so Render adds a
   suffix (e.g. `chat-api-x7k2.onrender.com`). The placeholder then points at someone else's
   service, and the web proxy fails with `socket hang up`.
   - `chat-api`: `PUBLIC_URL` = API URL, `WEB_ORIGIN` = web URL
   - `chat-web`: `API_PROXY_TARGET` = API URL, `NEXT_PUBLIC_REALTIME_URL` = API URL
5. Redeploy **chat-web** with **Manual Deploy → Clear build cache & deploy**. `NEXT_PUBLIC_*`
   values and the rewrite target are baked in at build time.
6. Mobile: build with `--dart-define=API_URL=https://<chat-api>.onrender.com`. Give the origin
   only; the app adds `/v1` and `/rt` itself.

### Smoke test

- `GET https://<chat-api>.onrender.com/v1/health` returns `{"status":"ok"}`.
- Sign in on the web app with the code from the API logs. Reload the page; you should still be
  signed in, which shows the refresh cookie works through the proxy.
- Upload an avatar; the object should appear in the S3 bucket. `AccessDenied` in the API
  logs means the IAM policy or bucket name is wrong; `PermanentRedirect` means `S3_REGION` doesn't
  match the bucket's region.

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
