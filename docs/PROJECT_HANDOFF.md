# Friend Poker Project Handoff

Canonical fast-recovery reference for the repository state after the Milestone 13
production release and the Session-ended start hotfix.

- Current main baseline: `8c12d4b Fix starting sessions after session end (#16)`
- Last repository verification: 2026-08-23
- M14 working branch: `feature/entry-action-clarity`
- M14 scope: entry availability and live previous-action clarity; do not infer further scope here

This file describes the current implementation snapshot, not an intermediate milestone or a
chat transcript.

## 1. Project snapshot

Friend Poker is a private, friends-only No-Limit Texas Hold'em web application using virtual
chips only. It has exactly one permanent table with six seats and two spectator slots. There
are no accounts, lobby, rooms, or matchmaking. Play is grouped into Sessions, and the server
is authoritative for all game state and rule decisions.

## 2. Canonical source hierarchy

Read these sources together:

1. `SPEC.md` is the product and behavior baseline. Per `AGENTS.md`, an implementation conflict
   is an implementation defect unless the specification is explicitly changed.
2. `docs/rules-policy.md` records approved clarifications where `SPEC.md` did not uniquely fix
   a behavior. If it appears to conflict with an explicit specification requirement, stop and
   request clarification rather than silently choosing one.
3. `AGENTS.md` defines repository-wide engineering, safety, testing, and workflow rules. It is
   mandatory operating guidance and is not displaced by this handoff.
4. `docs/PROJECT_HANDOFF.md` records current-main architecture, completed work, invariants,
   limitations, and safe resumption steps. It is a navigation and recovery aid, not a new
   product specification.
5. Code, tests, and Git history are evidence of what current `main` actually implements. Use
   them to verify claims. A code/test mismatch with the higher-level documents must be
   investigated, not silently promoted into policy.

When documents or implementation disagree, first determine whether the difference is an
explicit approved clarification, a stale handoff statement, or a defect. Do not redesign
behavior until that is resolved.

## 3. Current architecture

The current npm workspace contains three implemented packages and two applications. The web
application consumes browser-safe contracts from `packages/shared`; it does not import the
server runtime or poker engine.

```text
apps/web
  -> packages/shared
  -> HTTP identity entry + typed Socket.IO commands

apps/server
  -> packages/poker-engine
  -> Express / Socket.IO
  -> Prisma / SQLite

packages/shared
  -> browser-safe DTOs and transport contracts only

packages/poker-engine
  -> no React, Express, Socket.IO, or persistence dependency
```

### `packages/poker-engine`

Pure TypeScript domain logic, independently testable with injectable randomness:

- cards, deck construction/shuffling, and hand evaluation;
- betting state machine, seats/blinds, legal actions, full-raise and reopening rules;
- pot construction, unmatched-bet normalization, settlement, ties, and odd chips;
- hand orchestration, board progression, Runout, reveal, and safe hand records;
- table seating, host state, Session lifecycle, chip ledger, history, and hand integration.

Important exports include `evaluateBestHand`, `createBettingState`, `legalActions`,
`applyAction`, `constructPots`, `settleHand`, `startHand`, `applyHandAction`,
`createTableState`, `startSession`, `startFirstHand`, and `startNextHand`.

### `apps/server`

Authoritative application and process boundary:

- `SingleTableRuntime` serializes typed commands and owns version/idempotency checks;
- `projectTableState` creates per-viewer `SafeTableProjection` values;
- Express provides identity entry and health endpoints;
- Socket.IO authenticates credentials, derives the principal, handles typed commands, and
  broadcasts separate safe projections;
- `IdentityStore` owns Session-scoped identities and recovery credential digests;
- `LifecycleController` owns disconnect, host-grace, all-offline, and Runout scheduling through
  an injectable `LifecycleScheduler`;
- `PrismaPersistenceRepository` and `createPersistentPokerServer` own SQLite recovery.

Dependency direction is inward: transport calls the runtime, the runtime calls the poker
engine, and persistence supports the authoritative server. Transport and future UI must not
reimplement poker rules or become alternate sources of game truth.

### `packages/shared`

Browser-safe DTOs, public projection shapes, transport event names, identity responses, the M11
intent-only command envelope, and the fixed M12 reaction contract. It contains no server
runtime, persistence, credential, or private-hand implementation. `SafeTableProjection.viewerLegalActions`
is a server-derived, current-viewer-only action summary; it is null for spectators and
non-acting viewers.

### `apps/web`

React + TypeScript + Vite client foundation:

- HttpOnly-cookie identity recovery and nickname/seat/spectator entry;
- responsive six-seat oval table with public board, pot, street, hand status, host, online,
  offline, current-actor, contribution, and spectator state;
- own-hole-card-only rendering from the per-viewer projection;
- centralized versioned command submission for presence, gameplay, Session, replenishment, and
  host-control intents;
- server-provided legal-action dock with Raise-to amount entry, Pot quick buttons, and explicit
  same-envelope retry after an acknowledgement timeout;
- manual Session start/first-hand/next-hand flow, replenishment, blind changes, ledger-backed
  host chip adjustments, host transfer, kick, host force-Fold, and preview-confirmed Session end;
- static hand-ranking reference, safe recent hand history, retained Session summaries, six fixed
  transient emoji reactions with server rate limiting, opt-in sound cues, lightweight state
  motion, responsive/accessibility polish, and selective text-selection hardening;
- consecutive safe-projection flop/turn/river reveal presentation and a persistent safe hand
  result panel that reads actual main/side-pot payouts, ties, odd chips, and legally revealed
  showdown details without client-side winner calculation;
- the main Action Dock is the sole location for manual host Session progression (`START_SESSION`,
  `START_FIRST_HAND`, `START_NEXT_HAND`); non-hosts receive status-specific waiting copy, and
  host identity is matched by `hostPlayerId === viewerId`;
- reconnect, disconnect, revocation, stale-version, duplicate, and server-error feedback.
- `apps/web/DESIGN.md` is the canonical frontend visual-direction reference for M10.5 and later UI work.

The M11 client still does not calculate poker legality, reveal other players' cards, or send
authoritative identifiers. The server enriches browser intents with stable IDs and the
authenticated socket identity before invoking the runtime.

## 4. Milestone status

| Milestone | Git history name | Status | Architectural result |
| --- | --- | --- | --- |
| M1 | `Milestone 1: hand evaluator` | COMPLETE, merged | Card representation, best-five evaluation, ranking, and ties |
| M2 | `Implement Milestone 2 betting state machine` | COMPLETE, merged | Blinds, action order, legal actions, raises, All-in, reopening |
| M3 | `Implement Milestone 3 pot settlement` | COMPLETE, merged | Arbitrary pots, refunds, payouts, split pots, odd chips |
| M4 | `Implement Milestone 4 hand orchestrator` | COMPLETE, merged | Deal/progression/Runout/showdown/history orchestration |
| M5 | `Implement Milestone 5 table sessions and ledger` | COMPLETE, merged | Permanent table, seating, Sessions, chips, ledger, history |
| M6 | `Implement Milestone 6 authoritative runtime` | COMPLETE, merged | Serialized commands, principals, versions, idempotency, projections |
| M7 | `Implement Milestone 7 transport and identity` | COMPLETE, merged | Express/Socket.IO transport and credential-backed identity |
| M8 | `Implement Milestone 8 connection lifecycle` | COMPLETE, merged | Disconnect/host/offline timers, Runout pacing, admin lifecycle |
| M9 | `Implement Milestone 9 persistence recovery` | COMPLETE, merged | Prisma/SQLite checkpoints, durable identity/idempotency/recovery |
| M10 | Web foundation | IMPLEMENTED | Browser entry/recovery shell, safe shared contracts, six-seat public table projection, and presence commands |
| M11 | Fully playable game controls and host/session controls | IMPLEMENTED | Viewer-scoped legal actions, intent-only browser commands, playable betting UI, Session flow, replenishment, host controls, and acknowledgement-loss retry |
| M12 | Product completion and acceptance | IMPLEMENTED | Hand-ranking reference, safe history/Session summaries, reactions, opt-in sound, reduced-motion polish, initial TABLE_STATE command reconciliation, responsive/accessibility QA, and deployment readiness |
| M13 | Street reveal and hand-result presentation | IMPLEMENTED | Consecutive safe-projection community-card reveal overlay, persistent authoritative multi-pot hand result, legally scoped showdown details, and selective interaction-text-selection hardening |
| M14 | Entry availability and live action clarity | IN PROGRESS | Narrow public entry-capacity read model, live occupied-seat/spectator presentation, and persistent authoritative previous-action context |

Merged main milestones through M9 are visible in Git history from `cdf71e0` through `de44515`.
M10 through M13 are implemented in current main, including the M13 production release and
the `SESSION_ENDED` `START_SESSION` hotfix. M14 is active only on the feature branch and has
not been deployed.

## 5. Critical invariants

### Poker rules

- Standard No-Limit Texas Hold'em mechanics belong in `packages/poker-engine`.
- Main pots and an arbitrary number of Side Pots must settle independently.
- A short All-in does not by itself reopen raising for a player who already acted. Multiple
  short All-ins can cumulatively reopen action when the newly faced amount reaches a full
  bet/raise; the last full raise remains the minimum-raise basis.
- Unmatched excess contributions are refunded rather than placed into a pot.
- Chips are integers and must be conserved through betting and settlement.
- Split-pot odd chips are awarded positionally, starting left of the Button among tied,
  eligible winners. Suit never breaks a tie.
- Heads-up Button/blind/action order follows the approved standard rule.

### Chip accounting

- `INITIAL_GRANT`, `REPLENISHMENT`, and `HOST_ADJUSTMENT` are external chip flows and must be
  explicit ledger entries.
- Poker bets, refunds, pots, and payouts are internal transfers, not external ledger flows.
- Only external ledger flows may change the total chips belonging to the table/Session.
- A player's first participation in a Session grants exactly `+100` once. Reconnect, reseat,
  stand/sit, or kick re-entry must never duplicate it.
- Replenishment is exactly `+100`, not “top up to 100”. Host adjustments are recorded deltas,
  never unexplained balance overwrites.

### Authority and command semantics

- The browser sends `commandId`, `expectedVersion`, and a typed client command. It does not
  supply authoritative `actorId`.
- Browser gameplay commands are `FOLD`, `CHECK`, `CALL`, `BET`, `RAISE`, and `ALL_IN`; Session
  and host commands are intent-only. The server derives hand/session/ledger IDs and binds the
  actor from the authenticated socket. Browser payloads cannot create `SYSTEM` commands.
- The authenticated socket determines the player principal. Browser input cannot create a
  `SYSTEM` principal or send internal lifecycle commands.
- The server state and poker engine decide action order, legality, chip amounts, pots, cards,
  winners, and legal Raise-to bounds.
- `expectedVersion` rejects commands based on obsolete state. `commandId` protects retries and
  collisions; neither check may be removed to make a client flow easier.

### Privacy and projection

- Never serialize raw `TableState` to clients. It contains server-only state.
- Every response/broadcast uses a per-viewer `SafeTableProjection`.
- A player may receive only their own active hole cards; spectators receive none.
- Never broadcast all hole cards and rely on React/CSS to hide them.
- Folded, unrevealed cards remain private and never enter public payloads or history.
- `remainingDeck`, raw `privateHoleCards`, raw active-hand state, credentials, digests, Prisma
  rows, and command fingerprints are not client APIs.

### Idempotency

- Retrying the same successful command identity must not execute it twice.
- Reusing a `commandId` with a different principal or command fingerprint is rejected as
  `INVALID_COMMAND`, not accepted as a duplicate.
- Persisted duplicate lookup occurs before stale-version rejection, so a legitimate durable
  retry remains `DUPLICATE` after restart.
- Important successful non-hand commands retain durable idempotency across restart.
- First-Session `SIT` uses a deterministic server-owned initial-grant ledger ID and durable
  enrichment metadata. Browser-supplied ledger identity is not trusted, and retry/restart
  cannot issue a second `+100`.

## 6. Session and identity lifecycle

- `START_SESSION` creates the Session and grants eligible seated participants their first
  Session chips. It does not deal a hand.
- The host manually starts the first hand and every later hand. Hands never auto-start.
- Identity is Session/gathering-scoped, not a permanent account.
- Nicknames are trimmed, exact/case-sensitive, unique in the current identity generation,
  1–12 Unicode code points, and limited to Han characters, ASCII letters, and ASCII digits.
  There is no in-Session rename flow.
- Successful entry sets a 30-day `HttpOnly`, `SameSite=Strict`, `Path=/` recovery cookie;
  production also uses `Secure`. The duration of the browser cookie is not authorization past
  Session invalidation.
- One identity may have only one healthy controlling Socket.IO connection. A second live
  controller is rejected.
- A valid reconnect restores the same player ID, seat, chips, ledger participation, and
  Session record. Offline status affects future-hand eligibility, not identity ownership.
- Session end advances the identity generation, invalidates old credentials, clears current
  seat/online/host state, and disconnects old identities.
- Kick is revocation, not a permanent ban. Explicit kick re-entry issues a new credential for
  the same current-Session player record and does not issue a second initial grant.

Keep these three concepts separate:

1. disconnected current-turn wait: 60 seconds before administrative Fold;
2. disconnected host grace: 60 seconds before host transfer/removal;
3. recovery credential lifetime: valid for the current Session identity and not expired by
   either 60-second timer. The cookie's storage lifetime is also not a guarantee beyond
   Session invalidation.

## 7. Lifecycle timing

- Disconnected current actor: wait exactly 60 seconds, recheck authoritative state, then use
  administrative Fold if still applicable.
- Connected players: no normal action clock. Host force-Fold is an explicit friend-table
  management action, not an automatic online-player timeout.
- Disconnected host: 60-second grace. A reconnect during grace preserves host unless an
  explicit transfer has occurred.
- Host election: online seated players before online spectators; within a class, longest
  continuously online first; exact ties use lexical `playerId`.
- If no candidate exists after grace, host becomes null. The first later eligible reconnect
  acquires host under lifecycle rules.
- All players continuously offline: 30 minutes before automatic Session end. Any reconnect
  cancels/recomputes the continuous window. If a hand is live, end is deferred until safe.
- All-in Runout: Flop, Turn, and River advance in separately scheduled 750ms stages, including
  a delay before the first remaining stage.
- Explicit host leave transfers immediately; it does not receive disconnect grace.
- Every timer callback rechecks hand/session/actor/online identity, so cancelled or stale
  callbacks are harmless to later state.

See `docs/rules-policy.md` for the complete approved timing and election policy.

## 8. Administrative Fold boundary

The special trusted administrative Fold path exists because lifecycle and friend-table
management sometimes need to fold a live participant outside normal current-player betting
input. Approved reasons are:

- `DISCONNECT_TIMEOUT`
- `EXPLICIT_LEAVE`
- `KICK`
- `HOST_FORCE_FOLD`

This path does not replace normal betting legality or allow arbitrary server mutation.
Committed chips remain committed; the Fold never refunds them. It emits an audited hand event
with hand, target, reason, order, and operator where applicable, without private cards or
credentials. Only `HOST_FORCE_FOLD` is browser-triggerable, and runtime authorization limits it
to the host and the current actionable participant. Other reasons are internal lifecycle/table
operations.

## 9. Persistence and crash recovery

V1 production is fixed to Railway, one application replica, one persistent `/data` Volume,
Prisma, SQLite, and Node 22 (`>=22 <23`). Production uses:

```text
DATABASE_URL=file:/data/friend-poker.db
```

The Prisma schema has three persisted record groups:

- `ApplicationState`: snapshot schema/version high-water, identity generation, safe JSON
  checkpoint;
- `Identity`: player/nickname/state/generation and recovery credential digest;
- `ProcessedCommand`: principal key, command fingerprint, original result metadata, and the
  durable first-SIT enrichment flag when applicable.

Recovery policy:

```text
between hands  -> persist a validated safe checkpoint
hand starts    -> retain the pre-hand checkpoint
active hand    -> persist version high-water only; do not persist private hand state
crash/restart  -> restore pre-hand checkpoint, discard unfinished hand,
                  start strictly above the prior durable version high-water
completed hand -> atomically commit the resulting BETWEEN_HANDS checkpoint/version/command
```

Restored players start offline. Before the persistent server factory returns, it awaits an
initial lifecycle reconciliation so new-process host-grace and all-offline windows start even
without a browser connection. Old elapsed timer durations are not restored.

Exact mid-hand recovery is intentionally not implemented. Rolling an unfinished hand back to
its reliable pre-hand checkpoint and chip balances is approved product policy from `SPEC.md`,
not technical debt to “fix” casually by persisting decks or private hole cards.

## 10. Persistence security and idempotency

- Raw recovery credentials exist only at issuance/browser-cookie boundaries. SQLite stores a
  SHA-256 digest; raw credentials must never be logged, serialized, or queried by UI.
- At most the newest 4,096 durable successful command records are retained for the current
  gathering. Session end atomically clears them with identity-generation reset.
- `ApplicationState.runtimeVersion` is a version high-water mark. Its value can be newer than
  the safe snapshot's logical state during an abortable hand.
- Every applied version-producing mutation, including active-hand and connection/lifecycle
  changes, persists the required high-water before success is acknowledged.
- Persisted duplicate commands are checked before stale-version rejection; fingerprint and
  principal collision protection remains mandatory.
- A required database-write failure prevents a durable-success acknowledgement, marks
  persistence unhealthy, makes `/health` return 503, and causes later mutation attempts to
  fail closed.
- Prisma rows, credential digests, raw snapshot JSON, fingerprints, and server enrichment
  records are internal implementation details, not frontend read models.

## 11. History and retention

- Retain the newest 20 detailed safe hand records globally, across Sessions.
- Retain the newest 20 Session summaries independently of detailed-hand retention.
- Safe hand history contains board/action/settlement data and only hole cards revealed by
  approved Showdown or voluntary uncontested reveal rules.
- Folded unrevealed cards never enter history.
- Active private hand state never enters history or a durable checkpoint.

## 12. Current test baseline

Verified on the M14 implementation snapshot based on branch
`feature/entry-action-clarity` and baseline `main@8c12d4b`:

- standard suite: **435 tests** total;
- `apps/server`: **111 tests** across 13 test files;
- `apps/web`: **75 tests** across 12 test files;
- `packages/poker-engine`: **249 tests** across 28 test files;
- exhaustive evaluator suite: **1 additional exhaustive test**;
- CI migration smoke step, `npm run db:migrate:deploy --workspace @friend-poker/server`, remains
  part of the workflow;
- the workflow also verifies the Web production build.

CI uses Node 22 and runs `npm ci`, migration deploy, lint, typecheck, the standard suite, and
the exhaustive suite. Useful local commands are:

```sh
npm test
npm run test:exhaustive
npm run typecheck
npm run lint
npm run build
```

Run relevant focused tests while developing and the full checks before handoff. Never delete,
skip, or weaken tests merely to make CI pass; new behavior should extend the baseline.

## 13. Deployment shape

Railway V1 assumptions are architectural constraints:

- exactly one application replica;
- one persistent Railway Volume mounted at `/data`;
- SQLite database at `file:/data/friend-poker.db`;
- Node 22;
- `HOST=0.0.0.0`, Railway-provided `PORT`, and `NODE_ENV=production`;
- `ALLOWED_ORIGINS` contains the exact deployed frontend origin, not a permissive wildcard;
- `/health` is the health-check endpoint;
- production migration runs at runtime after the Volume is mounted, before server start;
- the deployment filesystem outside the Volume is ephemeral and must not hold the database.

V1 intentionally has no PostgreSQL, Redis, distributed lock, or horizontal scaling. More than
one replica would require a deliberate redesign of database concurrency, command ordering,
Socket.IO coordination, lifecycle ownership, and deployment policy.

See `docs/DEPLOYMENT_READINESS.md` for the M12 deployment checklist. The approved M13
production release is deployed to Railway; the current M14 branch has not been deployed.

## 14. Deliberate non-goals

V1 excludes:

- real money, payments, deposits, withdrawals, prizes, and commercial gambling;
- multiple tables, rooms, lobby, matchmaking, and ranking;
- permanent accounts, friend systems, and complex account recovery;
- text chat and built-in voice chat;
- tournaments and automatically increasing blinds;
- AI poker players;
- long-term analytics/rankings such as VPIP/PFR leaderboards;
- distributed infrastructure, microservices, Redis, Kubernetes, and multi-replica operation.

## 15. Known limitations after M13

- The approved M13 production release is deployed to Railway; the current M14 branch has not
  been deployed.
- The local acceptance environment used Node 24 despite the repository's required Node 22 range;
  deployment must use Node 22.x and CI remains the authoritative environment check.
- Persistence is deliberately constrained to SQLite and one process/replica.
- A process crash during a hand rolls back that unfinished hand to the pre-hand checkpoint.
- Exact persistent in-hand recovery is not supported and is intentionally out of scope.

Do not list already-fixed M5–M11 review defects as current limitations.

## 16. Next phase

M13 and its `SESSION_ENDED` start hotfix are complete on main. M14 is the currently approved
milestone on `feature/entry-action-clarity`; do not infer M15 scope. Production deployment and
Draft PR/CI review remain release-process steps, not permission to redesign the product.

The client consumes safe projections and typed commands only. React must not import private
poker-engine state, reproduce betting/settlement legality, calculate authoritative winners, or
use raw server persistence as a shortcut.

## 17. Fresh-agent startup procedure

For a new Codex task, engineer, or chat with no prior context:

1. Open the real local checkout: `D:\codex\friend-poker`.
2. Read completely, in this order:
   - `SPEC.md`
   - `AGENTS.md`
   - `docs/rules-policy.md`
   - `docs/PROJECT_HANDOFF.md`
3. Establish live Git state:

   ```sh
   git status -sb
   git branch --show-current
   git remote -v
   git log -10 --oneline
   ```

4. Ensure `main` is clean and matches `origin/main`; synchronize with
   `git pull --ff-only origin main` when authorized.
5. Read only the code and tests relevant to the next approved task, then verify any handoff
   claim that the task depends on.
6. Run the relevant existing tests before redesigning a subsystem. Run the full validation
   set before completion when the change warrants it.
7. Never treat prior chat context, a PR summary, or this file's old commit line as stronger
   evidence than the current repository.
8. Use the normal focused branch -> intentional commit -> push -> Draft PR workflow. Do not
   merge unless explicitly instructed.

Local Windows note: this reference checkout was verified with repository-local Git setting
`http.sslBackend=openssl`. It contains no secret. Only use or recheck that setting if Git HTTPS
certificate behavior on the same machine requires it; do not copy machine-specific Git config
blindly to another environment.

## 18. Things future agents must not “simplify”

DO NOT:

- replace per-viewer safe projections with raw-state broadcasting;
- send all hole cards to clients and hide them in React;
- move betting legality, pot construction, settlement, or winner selection into Socket.IO or
  React;
- trust browser `actorId`, player identity, chip values, or `SYSTEM` commands;
- remove expected-version or command-fingerprint collision protection;
- convert changed-fingerprint command collisions into valid duplicates;
- issue another `+100` on reconnect, reseat, stand/sit, or kick re-entry;
- merge disconnect Fold timeout, host grace, cookie duration, and Session credential lifetime;
- auto-start the first or next hand;
- reveal folded/unrevealed cards in payloads, history, logs, or persistence;
- refund already committed chips during administrative Fold;
- persist raw active-hand private state merely to obtain exact crash recovery;
- reinterpret approved pre-hand rollback as an accidental defect;
- turn Session identities into permanent accounts;
- replace SQLite with PostgreSQL without revisiting the explicit deployment decision;
- introduce Redis, microservices, or multi-replica infrastructure for single-table V1;
- weaken the one-controlling-connection rule;
- bypass the ledger with direct unexplained chip balance writes;
- lower coverage by deleting tests to make a new change pass.
