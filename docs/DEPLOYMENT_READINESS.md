# Deployment readiness

M12 documents the production shape but does not deploy it.

## Required Railway configuration

- Node `22.x` (`>=22 <23` from the root `package.json`).
- Exactly one application replica.
- One persistent Volume mounted at `/data`.
- `DATABASE_URL=file:/data/friend-poker.db`.
- `HOST=0.0.0.0` and Railway-provided `PORT`.
- `NODE_ENV=production`.
- `ALLOWED_ORIGINS` set to the exact deployed frontend origin; never `*`.
- Health check: `/health`.

The server process serves both the built Vite Web client and the Express/Socket.IO
backend from the same public origin. The browser therefore keeps using relative
`/identity/*` and `/socket.io/*` endpoints; no separate frontend service is required.

Build the Web client before starting the production server:

BUILD:

```sh
npm ci
npm run build
```

After the Volume is mounted at `/data`, run the migration and start the server:

RUNTIME:

```sh
npm run db:migrate:deploy --workspace @friend-poker/server
npm start --workspace @friend-poker/server
```

`npm start --workspace @friend-poker/server` fails clearly if the generated
`apps/web/dist/index.html` is missing. The production server serves `/` from that
build, serves its static assets, preserves `/health`, `/identity/*`, and
`/socket.io/*`, and applies SPA fallback only to non-server browser routes.

The SQLite file must live on the Volume. Do not migrate during image build,
commit runtime databases, or run more than one replica without an approved
concurrency/Socket.IO/lifecycle redesign.

## Pre-deploy checks

From the repository root:

```sh
npm ci
npm run db:migrate:deploy --workspace @friend-poker/server
npm run lint
npm run typecheck
npm test
npm run test:exhaustive
npm run build
```

After boot, verify `/health` returns 200, the browser origin is accepted, identity
cookies are Secure/HttpOnly/SameSite=Strict, and a two-client entry/action/
reconnect flow keeps private cards isolated. M12 performed local browser QA only;
no production deployment or production credential check was performed.
