# Friend Poker server

Milestone 8 provides one permanent Express and Socket.IO table around the
authoritative `SingleTableRuntime`. It does not provide rooms, a lobby, UI, or
persistence.

## Browser identity flow

`POST /identity/enter` accepts a nickname and either a spectator position or a
seat from 0 through 5. A successful new entry sets the opaque
`friend_poker_identity` recovery credential as a 30-day `HttpOnly`,
`SameSite=Strict`, `Path=/` cookie. Production configuration also sets
`Secure`. The credential is stored only in the in-memory identity registry and
is never returned in JSON or a Socket.IO payload.

Nicknames are trimmed and contain 1 through 12 Unicode code points. Only Han
characters, ASCII English letters, and ASCII digits are accepted. Spaces,
punctuation, emoji, and other scripts are rejected. Nicknames are exact and
case-sensitive. A valid recovery cookie restores the registered nickname and
ignores any attempted replacement.

A kicked identity may use the explicit `reenterAfterKick: true` entry path with
the same nickname. The server restores the existing player ID and Session
ledger identity, issues a new credential, and does not grant a second initial
stack.

## Socket protocol

The browser sends `TABLE_COMMAND` with only `commandId`, `expectedVersion`, and
the typed command. It never sends an authoritative actor or principal. The
server derives both from the credential-bound socket and acknowledges with the
Milestone 6 execution result.

An `APPLIED` result broadcasts a separately generated `TABLE_STATE` projection
to every connected identity. `NO_OP`, `DUPLICATE`, and `REJECTED` results are
acknowledged only to the caller. `IDENTITY_REVOKED` is sent before disconnecting
a successfully kicked identity.

## Process configuration

- `PORT` defaults to `3000`.
- `HOST` defaults to `0.0.0.0`.
- `ALLOWED_ORIGINS` is a comma-separated exact allowlist and defaults to
  `http://localhost:5173`.
- `NODE_ENV=production` enables `Secure` identity cookies.

Use `npm run dev --workspace @friend-poker/server` for watch mode or
`npm start --workspace @friend-poker/server` for the current TypeScript
bootstrap. Production build and deployment are deferred.

## Lifecycle timing

Milestone 8 owns connection timers through an injectable scheduler. Production defaults are:

- disconnected current actor Fold: 60 seconds;
- disconnected host transfer: 60 seconds;
- continuously all-offline Session end: 30 minutes;
- All-in board Runout: 750ms before each Flop, Turn, and River stage.

Connected players have no normal action clock. Recovery credentials do not expire at 60 seconds;
they remain valid for the current Session identity lifetime. Ending a Session revokes every old
credential, clears seats/online/host state, and requires fresh nickname entry with a new identity
for the next gathering. State and summaries remain in memory only.

Host election prefers online seated players, then online spectators. Within a class, the longest
continuously online player wins; exact ties use lexical `playerId`. Explicit host leave transfers
immediately without grace.

All administrative Folds preserve committed chips and write a safe hand-history audit event with
the reason (`DISCONNECT_TIMEOUT`, `EXPLICIT_LEAVE`, `KICK`, or `HOST_FORCE_FOLD`). Only
`HOST_FORCE_FOLD` is browser-visible, and it remains host-only and current-actor-only.
