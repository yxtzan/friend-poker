# Friend Poker server

Milestone 9 provides one permanent Express and Socket.IO table backed by a
Prisma/SQLite recovery store. The v1 production shape is deliberately narrow:
one Railway application replica and one persistent Railway Volume. There are
no rooms, lobby, UI, PostgreSQL, Redis, or horizontal scaling.

## Persistence and recovery

The repository stores three explicit record groups:

- `ApplicationState`: schema version, authoritative runtime version, identity
  generation, and a validated JSON checkpoint;
- `Identity`: Session/gathering-scoped player identity and SHA-256 recovery
  credential digest (never the raw cookie value);
- `ProcessedCommand`: principal, command fingerprint, original result metadata,
  and the server-owned SIT enrichment bit needed for durable retry safety.

The checkpoint contains only safe non-hand state: Session, balances, ledger,
seats, host, blinds, the newest 20 safe hand records, and the newest 20 Session
summaries. Serialization rejects `HAND_IN_PROGRESS` and never writes an active
hand's deck, private cards, or betting state.

Starting a hand leaves the prior non-hand checkpoint untouched. If the process
dies before the hand completes and commits, restart restores that checkpoint:
the unfinished hand disappears, balances return to their pre-hand values, and
no partial action, pot, runout, or history survives. A completed hand commits
its resulting `BETWEEN_HANDS` checkpoint and processed command in one SQLite
transaction before the Socket.IO acknowledgement is sent.

Every restart restores the persisted runtime version and advances it once,
then persists that recovery version. This makes pre-restart expected versions
stale without resetting the table to version zero. Restored players are always
offline; socket IDs and continuous-online timestamps are not durable. The host
identity is preserved and normal lifecycle rules resume as players reconnect.

Successful non-hand durable commands and their snapshot are committed
atomically. The in-memory Milestone 6 cache is seeded from the durable command
records. The table retains at most the newest 4,096 successful durable commands
for the current gathering; Session end deletes them after atomically committing
the ended Session and identity-generation reset. Commands belonging only to an
abortable active hand remain process-local. A persisted first-Session SIT also
stores its server-derived enrichment bit, so the same authenticated command ID
reconstructs the same runtime command after restart and returns `DUPLICATE`
without a second grant.

If a required SQLite write fails, that mutation is not acknowledged as durable
success. The process marks persistence unhealthy, `/health` returns 503, and
further mutations fail closed; v1 does not continue with memory knowingly ahead
of SQLite.

## Browser identity flow

`POST /identity/enter` accepts a nickname and a spectator or seat position. A
successful entry sets the opaque `friend_poker_identity` as a 30-day
`HttpOnly`, `SameSite=Strict`, `Path=/` cookie; production also sets `Secure`.
Only a SHA-256 digest of the high-entropy credential is retained in memory and
SQLite. The raw value is never returned in JSON, logged, or included in public
state.

An active credential survives a server restart in the same gathering. Kick
persists revocation before re-entry can issue a new credential. Session end
atomically advances the identity generation and removes current identities, so
old cookies remain invalid after restart and nickname uniqueness resets for the
next gathering.

## Local database commands

Use Node 22 (the repository requires `>=22 <23`). From the repository root:

```sh
npm install
npm run prisma:generate --workspace @friend-poker/server
npm run db:migrate:dev --workspace @friend-poker/server -- --name local
npm run db:test:setup --workspace @friend-poker/server
npm run db:migrate:deploy --workspace @friend-poker/server
```

`prisma:generate` generates the ignored Prisma client. `db:migrate:dev` creates
local development migrations. `db:test:setup` synchronizes a disposable test
database from the Prisma schema. `db:migrate:deploy` applies checked-in
migrations and is the production command. Set `DATABASE_URL` before running a
command; the local fallback is `file:./dev.db` relative to `apps/server/prisma`.
No database file is required by poker-engine unit tests.

## Railway v1 configuration

- exactly one application replica;
- one persistent Volume mounted at `/data`;
- `DATABASE_URL=file:/data/friend-poker.db`;
- `HOST=0.0.0.0`;
- `PORT` supplied by Railway;
- `NODE_ENV=production`;
- `ALLOWED_ORIGINS` set to the exact deployed frontend origin (comma-separated
  only when more than one explicit origin is required);
- health-check path `/health`.

Run production migration at runtime, when `/data` is mounted, and then start
the server:

```sh
npm run db:migrate:deploy --workspace @friend-poker/server && npm start --workspace @friend-poker/server
```

Do not run the production migration during image build because Railway Volumes
are not mounted then. This milestone documents the deployment but does not
perform it.

## Socket and lifecycle boundaries

The browser sends only `commandId`, `expectedVersion`, and a typed command. The
server derives the principal from the credential-bound socket. Public HTTP and
Socket.IO projections never contain raw snapshots, Prisma rows, credentials or
digests, command fingerprints, private hole cards, or remaining deck state.

Lifecycle timing remains unchanged: disconnected current actor Fold and host
transfer use 60 seconds, continuously all-offline Session end uses 30 minutes,
and each All-in runout stage uses 750ms. The administrative Fold API and normal
poker rules are unchanged.
