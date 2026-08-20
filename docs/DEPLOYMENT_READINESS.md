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

Run the migration only after the Volume is mounted, then start the server:

```sh
npm run db:migrate:deploy --workspace @friend-poker/server
npm start --workspace @friend-poker/server
```

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
