# Friend Poker Web

Milestone 10 adds the first browser client: a Chinese entry/recovery screen,
Socket.IO projection synchronization, and a six-seat table shell. The browser
only receives `SafeTableProjection` and sends the presence commands approved for
this milestone (`SIT`, `STAND_TO_SPECTATE`, and `LEAVE_TABLE`). Poker actions,
host controls, history, reactions, sound, and deployment remain deferred.

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
npm run build --workspace @friend-poker/web
```
