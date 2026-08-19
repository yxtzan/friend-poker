import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { NextFunction, Request, Response } from "express";
import { Server as SocketIOServer } from "socket.io";
import type { Socket } from "socket.io";

import { TableLifecycleStatus } from "@friend-poker/poker-engine";
import type { PlayerId, RandomSource, TableSeat } from "@friend-poker/poker-engine";
import {
  CommandRejectionReason,
  RuntimeCommandType,
} from "../runtime/types.js";
import type {
  CommandEnvelope,
  CommandExecutionResult,
  RejectedCommandResult,
  RuntimeCommand,
  SafeTableProjection,
} from "../runtime/types.js";
import { SingleTableRuntime } from "../runtime/runtime.js";
import {
  DEFAULT_IDENTITY_COOKIE_NAME,
  IdentityStore,
  readCookie,
  serializeIdentityCookie,
} from "./identity.js";
import type { IdentityStoreOptions } from "./identity.js";
import {
  ClientSitInitialGrantRegistry,
  clientSitInitialGrantLedgerEntryId,
} from "./initial-grant.js";
import { validateNickname } from "./nickname.js";
import { LifecycleController } from "./lifecycle.js";
import type { LifecycleScheduler } from "./scheduler.js";
import { SystemLifecycleScheduler } from "./scheduler.js";
import { TransportEvent } from "./types.js";
import type {
  ClientCommandInput,
  ClientToServerEvents,
  EntryPosition,
  IdentityResponse,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
  TransportErrorResponse,
} from "./types.js";

const SYSTEM_ID = "transport-lifecycle";

type PokerSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface PokerServerOptions extends IdentityStoreOptions {
  readonly runtime?: SingleTableRuntime;
  readonly allowedOrigins?: readonly string[];
  readonly secureCookies?: boolean;
  readonly cookieName?: string;
  readonly lifecycleScheduler?: LifecycleScheduler;
  readonly disconnectedTurnTimeoutMs?: number;
  readonly hostDisconnectGraceMs?: number;
  readonly allOfflineTimeoutMs?: number;
  readonly runoutStageDelayMs?: number;
}

export interface ListenOptions {
  readonly port?: number;
  readonly host?: string;
}

export interface ListeningPokerServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface PokerServer {
  readonly app: express.Express;
  readonly runtime: SingleTableRuntime;
  listen(options?: ListenOptions): Promise<ListeningPokerServer>;
  close(): Promise<void>;
  settleLifecycle(): Promise<void>;
}

function cryptoRandomSource(): RandomSource {
  return () => randomBytes(6).readUIntBE(0, 6) / 281_474_976_710_656;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePosition(value: unknown): EntryPosition | null {
  if (!isRecord(value)) return null;
  if (value.kind === "SPECTATOR") return Object.freeze({ kind: "SPECTATOR" });
  if (
    value.kind === "SEAT" &&
    Number.isInteger(value.seat) &&
    (value.seat as number) >= 0 &&
    (value.seat as number) <= 5
  ) {
    return Object.freeze({ kind: "SEAT", seat: value.seat as TableSeat });
  }
  return null;
}

function playerIsPresent(projection: SafeTableProjection, playerId: PlayerId): boolean {
  return (
    projection.seats.some((player) => player?.playerId === playerId) ||
    projection.spectators.some((player) => player.playerId === playerId)
  );
}

function playerHasInitialGrant(projection: SafeTableProjection, playerId: PlayerId): boolean {
  return (
    projection.session?.ledger.some(
      (entry) => entry.playerId === playerId && entry.type === "INITIAL_GRANT",
    ) ?? false
  );
}

function hasActiveSession(projection: SafeTableProjection): boolean {
  return (
    projection.status !== TableLifecycleStatus.NoSession &&
    projection.status !== TableLifecycleStatus.SessionEnded
  );
}

function authenticationError(code: string, message: string): Error {
  const error = new Error(message) as Error & { data?: { readonly code: string } };
  error.data = Object.freeze({ code });
  return error;
}

export function createPokerServer(options: PokerServerOptions = {}): PokerServer {
  const runtime =
    options.runtime ?? new SingleTableRuntime({ rngForHand: () => cryptoRandomSource() });
  const identities = new IdentityStore({
    ...(options.credentialGenerator === undefined
      ? {}
      : { credentialGenerator: options.credentialGenerator }),
    ...(options.playerIdGenerator === undefined
      ? {}
      : { playerIdGenerator: options.playerIdGenerator }),
  });
  const cookieName = options.cookieName ?? DEFAULT_IDENTITY_COOKIE_NAME;
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === "production";
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://localhost:5173"]);
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
    cors: {
      credentials: true,
      origin(origin, callback) {
        callback(null, origin === undefined || allowedOrigins.has(origin));
      },
    },
  });
  const socketIdByPlayer = new Map<PlayerId, string>();
  const clientSitInitialGrants = new ClientSitInitialGrantRegistry();
  let serverCommandSequence = 0;

  function nextServerCommandId(purpose: string): string {
    serverCommandSequence += 1;
    return `transport-${purpose}-${serverCommandSequence}`;
  }

  function playerProjection(playerId: PlayerId): SafeTableProjection {
    return runtime.getProjection({ kind: "PLAYER", playerId });
  }

  function rejectForPlayer(
    playerId: PlayerId,
    commandId: string,
    message: string,
  ): RejectedCommandResult {
    return Object.freeze({
      status: "REJECTED",
      commandId,
      version: runtime.version,
      reason: CommandRejectionReason.InvalidCommand,
      message,
      projection: playerProjection(playerId),
    });
  }

  async function executeSystem(command: RuntimeCommand): Promise<CommandExecutionResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await runtime.execute(
        Object.freeze({ kind: "SYSTEM", systemId: SYSTEM_ID }),
        Object.freeze({
          commandId: nextServerCommandId("system"),
          actorId: SYSTEM_ID,
          expectedVersion: runtime.version,
          command,
        }),
      );
      if (
        result.status !== "REJECTED" ||
        result.reason !== CommandRejectionReason.StaleVersion
      ) {
        return result;
      }
    }
    throw new Error("Could not serialize trusted lifecycle command");
  }

  function broadcastProjections(): void {
    for (const socket of io.sockets.sockets.values()) {
      const playerId = socket.data.playerId;
      if (playerId !== undefined) socket.emit(TransportEvent.TableState, playerProjection(playerId));
    }
  }

  async function enterIdentity(
    playerId: PlayerId,
    nickname: string,
    position: EntryPosition,
    includeInitialGrant: boolean,
  ): Promise<CommandExecutionResult> {
    const initialGrantId = includeInitialGrant
      ? nextServerCommandId("initial-grant")
      : null;
    let lastResult: CommandExecutionResult | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await runtime.execute(
        Object.freeze({ kind: "PLAYER", playerId }),
        Object.freeze({
          commandId: nextServerCommandId("enter"),
          actorId: playerId,
          expectedVersion: runtime.version,
          command: Object.freeze({
            type: RuntimeCommandType.EnterTable,
            nickname,
            online: socketIdByPlayer.has(playerId),
            position,
            ...(initialGrantId === null
              ? {}
              : { initialGrant: { ledgerEntryId: initialGrantId } }),
          }),
        }),
      );
      lastResult = result;
      if (
        result.status !== "REJECTED" ||
        result.reason !== CommandRejectionReason.StaleVersion
      ) {
        return result;
      }
    }
    if (lastResult === null) throw new Error("Identity entry did not execute");
    return lastResult;
  }

  const lifecycle = new LifecycleController({
    runtime,
    scheduler: options.lifecycleScheduler ?? new SystemLifecycleScheduler(),
    executeSystem,
    broadcast: broadcastProjections,
    onSessionEnded() {
      identities.invalidateSession();
      for (const socket of io.sockets.sockets.values()) {
        socket.data.suppressOffline = true;
        socket.emit(TransportEvent.IdentityRevoked, { reason: "SESSION_ENDED" });
        socket.disconnect(true);
      }
      socketIdByPlayer.clear();
    },
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

  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed" });
      return;
    }
    if (origin !== undefined) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "8kb" }));

  app.get("/", (_request, response) => {
    response.json({ service: "friend-poker", table: "permanent" });
  });
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/identity/enter", async (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const existingCredential = readCookie(request.header("cookie"), cookieName);
    const credentialIdentity = identities.findByCredential(existingCredential);
    const requestedPosition = parsePosition(body.position);

    if (credentialIdentity !== null) {
      const projection = playerProjection(credentialIdentity.playerId);
      if (!playerIsPresent(projection, credentialIdentity.playerId)) {
        if (requestedPosition === null) {
          response.status(400).json({
            error: "POSITION_REQUIRED",
            message: "A valid position is required to re-enter the table",
          } satisfies TransportErrorResponse);
          return;
        }
        const result = await enterIdentity(
          credentialIdentity.playerId,
          credentialIdentity.nickname,
          requestedPosition,
          requestedPosition.kind === "SEAT" &&
            hasActiveSession(projection) &&
            !playerHasInitialGrant(projection, credentialIdentity.playerId),
        );
        if (result.status === "REJECTED") {
          response.status(409).json({
            error: "ENTRY_REJECTED",
            message: result.message,
          } satisfies TransportErrorResponse);
          return;
        }
        if (result.status === "APPLIED") {
          broadcastProjections();
          await lifecycle.reconcile();
        }
      }
      if (existingCredential !== null) {
        response.setHeader(
          "Set-Cookie",
          serializeIdentityCookie(existingCredential, { cookieName, secure: secureCookies }),
        );
      }
      response.json({
        status: "RESTORED",
        playerId: credentialIdentity.playerId,
        nickname: credentialIdentity.nickname,
      } satisfies IdentityResponse);
      return;
    }

    const nicknameResult = validateNickname(body.nickname);
    if (!nicknameResult.ok) {
      response.status(400).json({
        error: nicknameResult.error,
        message: nicknameResult.message,
      } satisfies TransportErrorResponse);
      return;
    }
    if (requestedPosition === null) {
      response.status(400).json({
        error: "POSITION_REQUIRED",
        message: "Position must be an empty seat or spectator slot",
      } satisfies TransportErrorResponse);
      return;
    }

    const existingNickname = identities.findByNickname(nicknameResult.nickname);
    const controlledKickReentry = body.reenterAfterKick === true;
    if (existingNickname !== null) {
      if (existingNickname.state !== "KICKED" || !controlledKickReentry) {
        response.status(409).json({
          error: "NICKNAME_UNAVAILABLE",
          message: "Nickname is unavailable",
        } satisfies TransportErrorResponse);
        return;
      }
      const projection = playerProjection(existingNickname.playerId);
      const result = await enterIdentity(
        existingNickname.playerId,
        existingNickname.nickname,
        requestedPosition,
        requestedPosition.kind === "SEAT" &&
          hasActiveSession(projection) &&
          !playerHasInitialGrant(projection, existingNickname.playerId),
      );
      if (result.status === "REJECTED") {
        response.status(409).json({
          error: "ENTRY_REJECTED",
          message: result.message,
        } satisfies TransportErrorResponse);
        return;
      }
      const reissued = identities.reissueAfterKick(existingNickname.playerId);
      response.setHeader(
        "Set-Cookie",
        serializeIdentityCookie(reissued.credential, { cookieName, secure: secureCookies }),
      );
      response.json({
        status: "REENTERED",
        playerId: reissued.record.playerId,
        nickname: reissued.record.nickname,
      } satisfies IdentityResponse);
      if (result.status === "APPLIED") {
        broadcastProjections();
        await lifecycle.reconcile();
      }
      return;
    }

    const created = identities.create(nicknameResult.nickname);
    const projection = playerProjection(created.record.playerId);
    const result = await enterIdentity(
      created.record.playerId,
      created.record.nickname,
      requestedPosition,
      requestedPosition.kind === "SEAT" && hasActiveSession(projection),
    );
    if (result.status === "REJECTED") {
      identities.discardNewIdentity(created.record.playerId);
      response.status(409).json({
        error: "ENTRY_REJECTED",
        message: result.message,
      } satisfies TransportErrorResponse);
      return;
    }
    response.setHeader(
      "Set-Cookie",
      serializeIdentityCookie(created.credential, { cookieName, secure: secureCookies }),
    );
    response.status(201).json({
      status: "CREATED",
      playerId: created.record.playerId,
      nickname: created.record.nickname,
    } satisfies IdentityResponse);
    if (result.status === "APPLIED") {
      broadcastProjections();
      await lifecycle.reconcile();
    }
  });

  app.use(
    (
      _error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ): void => {
      void _next;
      response.status(400).json({
        error: "INVALID_HTTP_REQUEST",
        message: "Request could not be processed",
      } satisfies TransportErrorResponse);
    },
  );

  io.use((socket, next) => {
    void (async () => {
      const credential = readCookie(socket.handshake.headers.cookie, cookieName);
      const identity = identities.findByCredential(credential);
      if (identity === null) {
        next(authenticationError("AUTH_REQUIRED", "A valid recovery credential is required"));
        return;
      }
      const currentSocketId = socketIdByPlayer.get(identity.playerId);
      const currentSocket =
        currentSocketId === undefined ? undefined : io.sockets.sockets.get(currentSocketId);
      if (currentSocket?.connected === true) {
        next(
          authenticationError(
            "DUPLICATE_CONNECTION",
            "This identity already has an active connection",
          ),
        );
        return;
      }
      socketIdByPlayer.set(identity.playerId, socket.id);
      socket.data.playerId = identity.playerId;
      const onlineResult = await executeSystem({
        type: RuntimeCommandType.SetOnline,
        targetPlayerId: identity.playerId,
        online: true,
      });
      if (onlineResult.status === "REJECTED") {
        socketIdByPlayer.delete(identity.playerId);
        next(authenticationError("IDENTITY_NOT_PRESENT", "Identity is not present at the table"));
        return;
      }
      socket.data.onlineMutationApplied = onlineResult.status === "APPLIED";
      next();
    })().catch(() => {
      const playerId = socket.data.playerId;
      if (playerId !== undefined && socketIdByPlayer.get(playerId) === socket.id) {
        socketIdByPlayer.delete(playerId);
      }
      next(authenticationError("AUTHENTICATION_FAILED", "Could not bind identity"));
    });
  });

  io.on("connection", (socket: PokerSocket) => {
    const playerId = socket.data.playerId!;
    if (socket.data.onlineMutationApplied === true) broadcastProjections();
    else socket.emit(TransportEvent.TableState, playerProjection(playerId));
    void lifecycle.playerConnected(playerId).catch(() => undefined);

    socket.on(TransportEvent.TableCommand, (input: ClientCommandInput, acknowledge) => {
      if (typeof acknowledge !== "function") return;
      let acknowledged = false;
      void (async () => {
        const candidate = input as unknown;
        const inputRecord = isRecord(candidate) ? candidate : {};
        const commandRecord = isRecord(inputRecord.command) ? inputRecord.command : null;
        const commandId =
          typeof inputRecord.commandId === "string" ? inputRecord.commandId : "INVALID_COMMAND";
        if (commandRecord?.type === RuntimeCommandType.EnterTable) {
          acknowledge(
            rejectForPlayer(
              playerId,
              commandId,
              "Table entry and nickname binding use the controlled HTTP identity flow",
            ),
          );
          return;
        }

        let command = inputRecord.command as RuntimeCommand;
        if (commandRecord?.type === RuntimeCommandType.Sit) {
          const projection = playerProjection(playerId);
          const initialGrantLedgerEntryId = clientSitInitialGrantLedgerEntryId(
            playerId,
            commandId,
          );
          const includeInitialGrant = clientSitInitialGrants.resolve(
            playerId,
            commandId,
            hasActiveSession(projection) && !playerHasInitialGrant(projection, playerId),
          );
          command = {
            type: RuntimeCommandType.Sit,
            seat: commandRecord.seat as TableSeat,
            ...(includeInitialGrant
              ? {
                  initialGrant: {
                    ledgerEntryId: initialGrantLedgerEntryId,
                  },
                }
              : {}),
          };
        }
        const envelope = {
          commandId,
          actorId: playerId,
          expectedVersion: inputRecord.expectedVersion,
          command,
        } as CommandEnvelope;
        const result = await runtime.execute(
          Object.freeze({ kind: "PLAYER", playerId }),
          envelope,
        );
        acknowledge(result);
        acknowledged = true;

        if (result.status !== "APPLIED") return;
        if (command.type === RuntimeCommandType.LeaveTable) {
          socket.data.suppressOffline = true;
          socketIdByPlayer.delete(playerId);
          socket.disconnect(true);
          await lifecycle.playerDisconnected(playerId);
        }
        if (command.type === RuntimeCommandType.Kick) {
          const targetPlayerId = command.targetPlayerId;
          identities.revokeAfterKick(targetPlayerId);
          const targetSocketId = socketIdByPlayer.get(targetPlayerId);
          if (targetSocketId !== undefined) {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket !== undefined) {
              targetSocket.data.suppressOffline = true;
              targetSocket.emit(TransportEvent.IdentityRevoked, { reason: "KICKED" });
              targetSocket.disconnect(true);
            }
            socketIdByPlayer.delete(targetPlayerId);
          }
          await lifecycle.playerDisconnected(targetPlayerId);
        }
        broadcastProjections();
        await lifecycle.reconcile();
      })().catch(() => {
        if (!acknowledged) {
          acknowledge(rejectForPlayer(playerId, "INVALID_COMMAND", "Command could not be processed"));
        }
      });
    });

    socket.on("disconnect", () => {
      if (socketIdByPlayer.get(playerId) !== socket.id) return;
      socketIdByPlayer.delete(playerId);
      if (socket.data.suppressOffline === true) return;
      void executeSystem({
        type: RuntimeCommandType.SetOnline,
        targetPlayerId: playerId,
        online: false,
      })
        .then(async (result) => {
          if (result.status === "APPLIED") broadcastProjections();
          await lifecycle.playerDisconnected(playerId);
        })
        .catch(() => undefined);
    });
  });

  return Object.freeze({
    app,
    runtime,
    listen(listenOptions: ListenOptions = {}): Promise<ListeningPokerServer> {
      const host = listenOptions.host ?? "127.0.0.1";
      const port = listenOptions.port ?? 0;
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address() as AddressInfo;
          resolve(Object.freeze({ host, port: address.port, url: `http://${host}:${address.port}` }));
        });
      });
    },
    async close(): Promise<void> {
      lifecycle.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (!httpServer.listening) return;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    settleLifecycle(): Promise<void> {
      return lifecycle.settled();
    },
  });
}
