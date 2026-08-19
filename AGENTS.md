# AGENTS.md

## Project authority

This repository implements the private online Texas Hold'em game defined in `SPEC.md`.

Before making architectural, behavioral, or rule-related decisions, read `SPEC.md` completely.

If implementation behavior conflicts with `SPEC.md`, treat the implementation as wrong unless the specification is explicitly changed.

Do not silently reinterpret, simplify, or omit requirements from `SPEC.md`.

## Primary engineering principles

- Use TypeScript throughout the project unless there is a compelling technical reason not to.
- Keep the poker engine independent from React, Socket.IO, Express, and persistence code.
- The server is authoritative for all game state.
- Never trust client-reported game state, chip counts, action order, pot size, hand strength, or legal-action calculations.
- Never expose another player's private cards to a client that is not entitled to see them.
- Do not simplify standard No-Limit Texas Hold'em rules without explicit approval.
- Do not add features outside `SPEC.md` unless explicitly requested.
- Prefer simple, explicit architecture over unnecessary abstraction, microservices, or infrastructure.
- Optimize for correctness, maintainability, observability, and ease of debugging by a non-programmer who will primarily use Codex to maintain the repository.

## Suggested v1 technical direction

Unless a later architecture review produces a clear reason to change it, prefer:

- Frontend: React + TypeScript + Vite
- Backend: Node.js + TypeScript + Express
- Realtime: Socket.IO
- Poker rules: isolated TypeScript poker engine
- Persistence: Prisma with a simple relational database
- Local development persistence may begin with SQLite if deployment constraints permit

Treat this as a preferred direction, not permission to skip architecture review.

## Repository structure

Keep domain boundaries clear. A reasonable target structure is:

- `apps/web` — browser UI
- `apps/server` — authoritative server and realtime gateway
- `packages/poker-engine` — pure poker rules and state transitions
- `packages/shared` — shared DTOs/types that are safe for clients
- `prisma` or equivalent persistence schema area

Do not put secret/private server-only state into shared client packages.

## Poker engine rules

The poker engine should be testable without a browser, database, Express server, or Socket.IO connection.

It should own deterministic rule logic such as:

- card/deck representation
- seating and dealer movement
- blinds and action order
- legal actions
- Fold / Check / Call / Bet / Raise / All-in
- minimum raise logic
- betting-round completion
- board progression
- hand evaluation
- main-pot and arbitrary side-pot construction
- unmatched-bet refunds
- showdown eligibility
- split pots and odd chips
- heads-up rules
- chip conservation invariants

Randomness should be injectable or otherwise controllable in tests so hands can be reproduced.

## Server authority and security

All gameplay actions must be validated on the server against the current authoritative state.

Reject stale, duplicate, malformed, illegal, out-of-turn, or impossible actions.

Never send full hidden game state to every client.

Create per-client/public projections of game state so that:

- a player can see only their own private cards
- spectators see no private cards
- folded unrevealed cards never leak through payloads
- history contains only cards that were legitimately revealed

Avoid storing secrets in the repository. Environment variables and local secrets must remain ignored by Git.

## State transitions and idempotency

Game actions should be represented as explicit commands/events or equivalent well-defined transitions.

The server should have a clear strategy for preventing duplicate action execution caused by:

- double clicks
- network retries
- stale clients
- repeated Socket.IO messages
- reconnect races

When practical, include a game/hand/version identifier with client actions and reject actions based on obsolete state.

## Persistence

Persistence should explain, not obscure, game state.

Important persisted information includes the Session, chip ledger, seat/player identity state, recent hand history, and recent Session history as required by `SPEC.md`.

Chip mutations from outside normal poker settlement must be represented as ledger entries, not unexplained direct balance overwrites.

For an in-progress hand, design rollback/recovery so an unrecoverable server failure can restore the reliable pre-hand state, as required by `SPEC.md`.

## Testing

Every poker-rule change must include or update automated tests.

Before considering a task complete:

1. Run the relevant tests.
2. Run the full test suite when appropriate.
3. Run TypeScript type checking.
4. Run linting if configured.
5. Review the diff for regressions and accidental scope expansion.
6. Confirm behavior against `SPEC.md`.
7. Report what was implemented, what was tested, and what remains intentionally unimplemented.

Do not claim a feature is complete merely because the application starts or the UI renders.

## Required high-value test areas

Give special attention to:

- hand evaluation
- A2345 straight handling
- identical best-five-card ties
- heads-up blind/action order
- legal action calculation
- minimum-raise reopening rules
- short-stack All-in behavior
- arbitrary side pots
- unmatched-bet refunds
- split pots
- odd chips
- multiple simultaneous All-ins
- chip conservation
- reconnect behavior
- stale/duplicate actions
- private-card projection
- ledger correctness

Property-style or randomized tests are encouraged for invariants such as chip conservation and pot distribution, provided failures are reproducible.

## Development workflow

Work in small milestones.

For each milestone:

1. State the exact scope before changing code.
2. Do not implement later milestones unless explicitly asked.
3. Keep the diff focused.
4. Add/update tests in the same milestone.
5. Run checks.
6. Summarize the result and any unresolved risks.

If a task reveals ambiguity in `SPEC.md` that could materially affect architecture or gameplay behavior, stop and surface the ambiguity rather than inventing a rule.

## UI language

The product UI should be primarily Chinese.

Poker terminology may use bilingual labels where useful, for example:

- 弃牌 Fold
- 过牌 Check
- 跟注 Call
- 加注 Raise
- 全下 All-in

Do not unnecessarily English-ify ordinary interface text.

## Scope discipline

v1 is a private friends-only single-table poker product.

Do not introduce unnecessary systems such as:

- multi-table orchestration
- matchmaking
- tournament infrastructure
- formal authentication
- payments
- ranking ladders
- microservices
- Kubernetes
- Redis clusters
- event buses
- enterprise observability stacks

unless a later explicit requirement justifies them.
