# Friend Poker Web

The browser is a Chinese, projection-only client for the private six-seat table.
It uses HttpOnly-cookie identity recovery, server-derived legal actions, typed
versioned commands, safe recent hand/Session history, fixed transient reactions,
opt-in Web Audio cues, and responsive table controls. It never imports the
server runtime or private poker-engine state.

## Local development

From the repository root, start the existing server in one terminal:

```sh
npm run dev --workspace @friend-poker/server
```

Start the Vite client in another:

```sh
npm run dev --workspace @friend-poker/web
```

Vite proxies `/identity`, `/health`, and `/socket.io` to
`http://localhost:3000`. Set `VITE_SERVER_ORIGIN` when the local server uses a
different origin. The browser uses `credentials: include`; the recovery cookie
is HttpOnly and is never read by JavaScript.

Useful checks:

```sh
npm run test --workspace @friend-poker/web
npm run typecheck --workspace @friend-poker/web
npm run build --workspace @friend-poker/web
```

The Vite client proxies `/identity`, `/health`, and `/socket.io` to the server.
For a non-default Vite port, set the server's `ALLOWED_ORIGINS` to the exact
frontend origin used by the browser; do not use a wildcard in production.
