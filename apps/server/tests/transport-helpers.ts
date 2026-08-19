import { io as createSocketClient } from "socket.io-client";
import type { Socket as ClientSocket } from "socket.io-client";

import type { PlayerId } from "@friend-poker/poker-engine";
import {
  createPokerServer,
  TransportEvent,
} from "../src/index.js";
import type {
  ClientCommandInput,
  ClientToServerEvents,
  CommandExecutionResult,
  EntryPosition,
  IdentityResponse,
  LifecycleScheduler,
  PokerServer,
  SafeTableProjection,
  ServerToClientEvents,
  TransportErrorResponse,
} from "../src/index.js";

export const TEST_ORIGIN = "http://test.friend-poker.local";

export type TestSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

export interface HttpIdentityResult {
  readonly status: number;
  readonly body: IdentityResponse | TransportErrorResponse;
  readonly setCookie: string | null;
  readonly cookie: string | null;
}

export interface ConnectedClient {
  readonly identity: IdentityResponse;
  readonly cookie: string;
  readonly setCookie: string;
  readonly socket: TestSocket;
  readonly initialProjection: SafeTableProjection;
  latestProjection: SafeTableProjection;
}

export interface TransportFixture {
  readonly server: PokerServer;
  readonly url: string;
  readonly issuedCredentials: readonly string[];
  readonly sockets: Set<TestSocket>;
  close(): Promise<void>;
}

export async function createTransportFixture(
  options: {
    readonly secureCookies?: boolean;
    readonly lifecycleScheduler?: LifecycleScheduler;
    readonly disconnectedTurnTimeoutMs?: number;
    readonly hostDisconnectGraceMs?: number;
    readonly allOfflineTimeoutMs?: number;
    readonly runoutStageDelayMs?: number;
  } = {},
) {
  let credentialSequence = 0;
  let playerSequence = 0;
  const issuedCredentials: string[] = [];
  const server = createPokerServer({
    allowedOrigins: [TEST_ORIGIN],
    secureCookies: options.secureCookies ?? false,
    credentialGenerator: () => {
      credentialSequence += 1;
      const credential = `test-recovery-credential-${String(credentialSequence).padStart(16, "0")}`;
      issuedCredentials.push(credential);
      return credential;
    },
    playerIdGenerator: () => {
      playerSequence += 1;
      return `player-${playerSequence}`;
    },
    ...(options.lifecycleScheduler === undefined
      ? {}
      : { lifecycleScheduler: options.lifecycleScheduler }),
    ...(options.disconnectedTurnTimeoutMs === undefined
      ? {}
      : { disconnectedTurnTimeoutMs: options.disconnectedTurnTimeoutMs }),
    ...(options.hostDisconnectGraceMs === undefined
      ? {}
      : { hostDisconnectGraceMs: options.hostDisconnectGraceMs }),
    ...(options.allOfflineTimeoutMs === undefined
      ? {}
      : { allOfflineTimeoutMs: options.allOfflineTimeoutMs }),
    ...(options.runoutStageDelayMs === undefined
      ? {}
      : { runoutStageDelayMs: options.runoutStageDelayMs }),
  });
  const listening = await server.listen();
  const sockets = new Set<TestSocket>();
  return Object.freeze({
    server,
    url: listening.url,
    issuedCredentials,
    sockets,
    async close(): Promise<void> {
      for (const socket of sockets) socket.disconnect();
      await server.close();
    },
  }) satisfies TransportFixture;
}

function cookiePair(setCookie: string | null): string | null {
  return setCookie?.split(";", 1)[0] ?? null;
}

export async function enterIdentity(
  fixture: TransportFixture,
  nickname: unknown,
  position: EntryPosition,
  options: { readonly cookie?: string; readonly reenterAfterKick?: boolean } = {},
): Promise<HttpIdentityResult> {
  const response = await fetch(`${fixture.url}/identity/enter`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: TEST_ORIGIN,
      ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
    },
    body: JSON.stringify({
      nickname,
      position,
      ...(options.reenterAfterKick === undefined
        ? {}
        : { reenterAfterKick: options.reenterAfterKick }),
    }),
  });
  const setCookie = response.headers.get("set-cookie");
  return Object.freeze({
    status: response.status,
    body: (await response.json()) as IdentityResponse | TransportErrorResponse,
    setCookie,
    cookie: cookiePair(setCookie),
  });
}

function waitForConnect(socket: TestSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

export function waitForProjection(
  socket: TestSocket,
  predicate: (projection: SafeTableProjection) => boolean = () => true,
): Promise<SafeTableProjection> {
  return new Promise((resolve) => {
    const listener = (projection: SafeTableProjection): void => {
      if (!predicate(projection)) return;
      socket.off(TransportEvent.TableState, listener);
      resolve(projection);
    };
    socket.on(TransportEvent.TableState, listener);
  });
}

export async function connectWithCookie(
  fixture: TransportFixture,
  cookie: string,
): Promise<{ readonly socket: TestSocket; readonly initialProjection: SafeTableProjection }> {
  const socket: TestSocket = createSocketClient(fixture.url, {
    autoConnect: false,
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: TEST_ORIGIN },
  });
  fixture.sockets.add(socket);
  const projectionPromise = waitForProjection(socket);
  const connectPromise = waitForConnect(socket);
  socket.connect();
  await connectPromise;
  const initialProjection = await projectionPromise;
  await fixture.server.settleLifecycle();
  return Object.freeze({ socket, initialProjection });
}

export async function createConnectedClient(
  fixture: TransportFixture,
  nickname: string,
  position: EntryPosition,
): Promise<ConnectedClient> {
  const entered = await enterIdentity(fixture, nickname, position);
  if (entered.status !== 201 || entered.cookie === null || entered.setCookie === null) {
    throw new Error(`Could not enter identity ${nickname}`);
  }
  const identity = entered.body as IdentityResponse;
  const connected = await connectWithCookie(fixture, entered.cookie);
  const client: ConnectedClient = {
    identity,
    cookie: entered.cookie,
    setCookie: entered.setCookie,
    socket: connected.socket,
    initialProjection: connected.initialProjection,
    latestProjection: connected.initialProjection,
  };
  connected.socket.on(TransportEvent.TableState, (projection) => {
    client.latestProjection = projection;
  });
  return client;
}

export function executeSocketCommand(
  socket: TestSocket,
  input: ClientCommandInput | unknown,
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    socket.emit(
      TransportEvent.TableCommand,
      input as ClientCommandInput,
      (result) => resolve(result),
    );
  });
}

export async function expectConnectionError(
  fixture: TransportFixture,
  cookie: string,
): Promise<string | undefined> {
  const socket: TestSocket = createSocketClient(fixture.url, {
    autoConnect: false,
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: TEST_ORIGIN },
  });
  fixture.sockets.add(socket);
  const error = await new Promise<Error & { data?: { readonly code?: string } }>((resolve) => {
    socket.once("connect_error", resolve);
    socket.connect();
  });
  socket.disconnect();
  return error.data?.code;
}

export function nextCommand(
  projection: SafeTableProjection,
  commandId: string,
  command: ClientCommandInput["command"],
): ClientCommandInput {
  return Object.freeze({ commandId, expectedVersion: projection.version, command });
}

export function findPublicPlayer(projection: SafeTableProjection, playerId: PlayerId) {
  return [
    ...projection.seats.filter((player) => player !== null),
    ...projection.spectators,
  ].find((player) => player.playerId === playerId);
}

export async function synchronizeClients(
  clients: readonly ConnectedClient[],
): Promise<number> {
  const targetVersion = Math.max(...clients.map((client) => client.latestProjection.version));
  await Promise.all(
    clients.map((client) =>
      client.latestProjection.version >= targetVersion
        ? Promise.resolve(client.latestProjection)
        : waitForProjection(client.socket, (projection) => projection.version >= targetVersion),
    ),
  );
  return targetVersion;
}

export async function waitForDisconnect(socket: TestSocket): Promise<void> {
  if (!socket.connected) return;
  await new Promise<void>((resolve) => socket.once("disconnect", () => resolve()));
}
