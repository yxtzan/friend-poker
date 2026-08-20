import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TableLifecycleStatus } from "@friend-poker/poker-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { createPersistentPokerServer } from "../src/persistence/create-server.js";
import { PrismaPersistenceRepository } from "../src/persistence/repository.js";
import { recoveryCredentialDigest } from "../src/transport/identity.js";
import { clientSitInitialGrantLedgerEntryId } from "../src/transport/initial-grant.js";
import { RuntimeCommandType } from "../src/index.js";
import type { CommandExecutionSuccess, SafeTableProjection } from "../src/index.js";
import {
  connectWithCookie,
  createConnectedClient,
  enterIdentity,
  executeSocketCommand,
  expectConnectionError,
  findPublicPlayer,
  nextCommand,
  synchronizeClients,
  waitForProjection,
} from "./transport-helpers.js";
import type { ConnectedClient, TransportFixture } from "./transport-helpers.js";
import {
  databasePath,
  migrateTestDatabase,
  persistentFixtureFactory,
} from "./persistence-helpers.js";
import type { PersistentFixtureFactory } from "./persistence-helpers.js";
import type { PersistentFixtureStartOptions } from "./persistence-helpers.js";
import { FakeLifecycleScheduler } from "./fake-lifecycle-scheduler.js";

let temporaryRoot: string;
let fixture: TransportFixture | undefined;
let factory: PersistentFixtureFactory;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "friend-poker-persistence-"));
  factory = persistentFixtureFactory(databasePath(temporaryRoot));
  migrateTestDatabase(factory.databaseUrl);
  fixture = await factory.start();
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  await rm(temporaryRoot, { recursive: true, force: true });
});

function projection(): SafeTableProjection {
  return fixture!.server.runtime.getProjection({ kind: "SPECTATOR" });
}

async function restart(options: PersistentFixtureStartOptions = {}): Promise<void> {
  await fixture!.close();
  fixture = await factory.start(options);
}

async function createSeatedPlayers(count = 2): Promise<ConnectedClient[]> {
  const clients: ConnectedClient[] = [];
  for (let index = 0; index < count; index += 1) {
    clients.push(
      await createConnectedClient(fixture!, `Persist${index + 1}`, {
        kind: "SEAT",
        seat: index as 0 | 1 | 2,
      }),
    );
  }
  await synchronizeClients(clients);
  return clients;
}

async function startSession(clients: readonly ConnectedClient[], suffix: string) {
  const result = await executeSocketCommand(
    clients[0]!.socket,
    nextCommand(clients[0]!.latestProjection, `start-session-${suffix}`, {
      type: RuntimeCommandType.StartSession,
      sessionId: `session-${suffix}`,
      initialGrants: clients.map((client) => ({
        playerId: client.identity.playerId,
        ledgerEntryId: `initial-${suffix}-${client.identity.playerId}`,
      })),
    }),
  );
  expect(result.status).toBe("APPLIED");
  await synchronizeClients(clients);
  return result;
}

async function startFirstHand(clients: readonly ConnectedClient[], suffix: string) {
  const result = await executeSocketCommand(
    clients[0]!.socket,
    nextCommand(clients[0]!.latestProjection, `start-hand-${suffix}`, {
      type: RuntimeCommandType.StartFirstHand,
      handId: `hand-${suffix}`,
      buttonSeat: 0,
    }),
  );
  expect(result.status).toBe("APPLIED");
  await synchronizeClients(clients);
  return result;
}

function clientById(clients: readonly ConnectedClient[], playerId: string): ConnectedClient {
  const client = clients.find((candidate) => candidate.identity.playerId === playerId);
  if (client === undefined) throw new Error(`Missing client ${playerId}`);
  return client;
}

describe("durable checkpoint recovery", () => {
  it("rolls an unfinished hand back to the pre-hand checkpoint", async () => {
    const clients = await createSeatedPlayers(3);
    const started = await startSession(clients, "rollback");
    const preHandBalances = Object.fromEntries(
      started.projection.seats
        .filter((player) => player !== null)
        .map((player) => [player.playerId, player.chipBalance]),
    );
    let active = await startFirstHand(clients, "rollback");

    for (let actionIndex = 0; actionIndex < 2; actionIndex += 1) {
      const hand = active.projection.currentHand;
      if (hand === null || hand.currentActorId === null) throw new Error("Hand ended too early");
      const actor = hand.participants.find(
        (participant) => participant.playerId === hand.currentActorId,
      )!;
      active = await executeSocketCommand(clientById(clients, hand.currentActorId).socket, {
        commandId: `rollback-action-${actionIndex}`,
        expectedVersion: active.version,
        command:
          actor.streetContribution === hand.currentBet
            ? { type: "CHECK" }
            : { type: "CALL" },
      });
      expect(active.status).toBe("APPLIED");
    }
    expect(active.projection.currentHand).not.toBeNull();
    const highestActionVersion = active.version;
    const lastPreRestartVersion = projection().version;

    const cookies = clients.map((client) => client.cookie);
    const playerIds = clients.map((client) => client.identity.playerId);
    await restart();

    const recovered = projection();
    expect(lastPreRestartVersion).toBeGreaterThanOrEqual(highestActionVersion);
    expect(recovered.version).toBeGreaterThan(lastPreRestartVersion);
    expect(recovered.status).toBe(TableLifecycleStatus.WaitingForFirstHand);
    expect(recovered.currentHand).toBeNull();
    expect(recovered.recentHands).toHaveLength(0);
    expect(recovered.session?.sessionId).toContain("session-rollback");
    expect(recovered.hostPlayerId).toBe(playerIds[0]);
    for (const playerId of playerIds) {
      expect(findPublicPlayer(recovered, playerId)).toMatchObject({
        online: false,
        chipBalance: preHandBalances[playerId],
      });
    }

    for (let index = 0; index < cookies.length; index += 1) {
      const connected = await connectWithCookie(fixture!, cookies[index]!);
      expect(findPublicPlayer(connected.initialProjection, playerIds[index]!)).toMatchObject({
        playerId: playerIds[index],
        chipBalance: preHandBalances[playerIds[index]!],
      });
    }
  });

  it("restores one completed safe hand and continues Button progression", async () => {
    const clients = await createSeatedPlayers();
    await startSession(clients, "completed");
    const active = await startFirstHand(clients, "completed");
    const actorId = active.projection.currentHand!.currentActorId!;
    const completed = await executeSocketCommand(clientById(clients, actorId).socket, {
      commandId: "complete-by-fold",
      expectedVersion: active.version,
      command: { type: "FOLD" },
    });
    expect(completed.status).toBe("APPLIED");
    expect(completed.projection.status).toBe(TableLifecycleStatus.BetweenHands);
    const balances = completed.projection.seats
      .filter((player) => player !== null)
      .map((player) => [player.playerId, player.chipBalance] as const);
    const cookies = clients.map((client) => client.cookie);

    await restart();
    const recovered = projection();
    expect(recovered.session?.completedHandCount).toBe(1);
    expect(recovered.session?.lastButtonSeat).toBe(0);
    expect(recovered.recentHands).toHaveLength(1);
    expect(JSON.stringify(recovered.recentHands[0])).not.toMatch(
      /privateHoleCards|remainingDeck|activeHand/iu,
    );
    for (const [playerId, balance] of balances) {
      expect(findPublicPlayer(recovered, playerId)?.chipBalance).toBe(balance);
    }

    const host = await connectWithCookie(fixture!, cookies[0]!);
    await connectWithCookie(fixture!, cookies[1]!);
    const current =
      host.initialProjection.version === projection().version
        ? host.initialProjection
        : await waitForProjection(host.socket, (state) => state.version === projection().version);
    const next = await executeSocketCommand(
      host.socket,
      nextCommand(current, "start-next-after-restart", {
        type: RuntimeCommandType.StartNextHand,
        handId: "hand-after-restart",
      }),
    );
    expect(next.status).toBe("APPLIED");
    expect(next.projection.currentHand?.buttonSeat).toBe(1);
  });

  it("keeps both 20-record history limits when the 21st record follows a restart", async () => {
    let clients = await createSeatedPlayers();
    const initialSession = await startSession(clients, "retention-0");
    let completed = initialSession.projection;
    for (let handIndex = 0; handIndex < 20; handIndex += 1) {
      const command =
        handIndex === 0
          ? {
              type: RuntimeCommandType.StartFirstHand,
              handId: `retention-hand-${handIndex}`,
              buttonSeat: 0 as const,
            }
          : {
              type: RuntimeCommandType.StartNextHand,
              handId: `retention-hand-${handIndex}`,
            };
      const start = await executeSocketCommand(
        clients[0]!.socket,
        nextCommand(completed, `retention-start-${handIndex}`, command),
      );
      expect(start.status).toBe("APPLIED");
      const actorId = start.projection.currentHand!.currentActorId!;
      const folded = await executeSocketCommand(clientById(clients, actorId).socket, {
        commandId: `retention-fold-${handIndex}`,
        expectedVersion: start.version,
        command: { type: "FOLD" },
      });
      expect(folded.status).toBe("APPLIED");
      completed = folded.projection;
    }
    expect(completed.recentHands).toHaveLength(20);
    const cookies = clients.map((client) => client.cookie);

    await restart();
    const connected = await Promise.all(cookies.map((cookie) => connectWithCookie(fixture!, cookie)));
    const hostSocket = connected[0]!.socket;
    const otherSocket = connected[1]!.socket;
    const nextStart = await executeSocketCommand(
      hostSocket,
      nextCommand(projection(), "retention-start-20", {
        type: RuntimeCommandType.StartNextHand,
        handId: "retention-hand-20",
      }),
    );
    const actorSocket =
      nextStart.projection.currentHand!.currentActorId === clients[0]!.identity.playerId
        ? hostSocket
        : otherSocket;
    const twentyFirst = await executeSocketCommand(actorSocket, {
      commandId: "retention-fold-20",
      expectedVersion: nextStart.version,
      command: { type: "FOLD" },
    });
    expect(twentyFirst.projection.recentHands).toHaveLength(20);
    expect(
      twentyFirst.projection.recentHands.some(
        (entry) => entry.record.handId.includes("retention-start-0"),
      ),
    ).toBe(false);
    expect(twentyFirst.projection.recentHands.at(-1)?.record.handId).toContain("retention-start-20");

    async function endCurrentSession(
      socket: typeof hostSocket,
      current: SafeTableProjection,
      suffix: string,
    ): Promise<SafeTableProjection> {
      const prepared = await executeSocketCommand(
        socket,
        nextCommand(current, `retention-prepare-${suffix}`, {
          type: RuntimeCommandType.PrepareEndSession,
        }),
      );
      const data = (prepared as CommandExecutionSuccess).data;
      if (data.kind !== "SESSION_END_PREVIEW") throw new Error("Missing end preview");
      const ended = await executeSocketCommand(socket, {
        commandId: `retention-end-${suffix}`,
        expectedVersion: prepared.version,
        command: { type: RuntimeCommandType.EndSession, confirmation: data.preview },
      });
      expect(ended.status).toBe("APPLIED");
      return ended.projection;
    }

    let ended = await endCurrentSession(hostSocket, twentyFirst.projection, "0");
    for (let sessionIndex = 1; sessionIndex < 20; sessionIndex += 1) {
      clients = await createSeatedPlayers();
      const started = await startSession(clients, `retention-${sessionIndex}`);
      ended = await endCurrentSession(
        clients[0]!.socket,
        started.projection,
        String(sessionIndex),
      );
    }
    expect(ended.recentSessions).toHaveLength(20);

    await restart();
    clients = await createSeatedPlayers();
    const latest = await startSession(clients, "retention-20");
    const twentyFirstSession = await endCurrentSession(
      clients[0]!.socket,
      latest.projection,
      "20",
    );
    expect(twentyFirstSession.recentSessions).toHaveLength(20);
    expect(
      twentyFirstSession.recentSessions.some((entry) => entry.sessionId === "session-retention-0"),
    ).toBe(false);
    expect(twentyFirstSession.recentSessions.at(-1)?.sessionId).toContain("session-retention-20");
  }, 120_000);
});

describe("recovered lifecycle initialization", () => {
  it("starts a fresh all-offline window before any client reconnects", async () => {
    const clients = await createSeatedPlayers();
    await startSession(clients, "startup-offline");
    const clock = new FakeLifecycleScheduler();
    await restart({ lifecycleScheduler: clock });

    const recovered = projection();
    const recoveredPlayers = [
      ...recovered.seats.filter((player) => player !== null),
      ...recovered.spectators,
    ];
    expect(recoveredPlayers.every((player) => !player.online)).toBe(true);
    expect(recovered.status).toBe(TableLifecycleStatus.WaitingForFirstHand);

    clock.advanceBy(30 * 60_000 - 1);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.WaitingForFirstHand);

    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.SessionEnded);
  });

  it("starts offline-host grace and clears the host at 60 seconds without a candidate", async () => {
    const clients = await createSeatedPlayers();
    await startSession(clients, "startup-host");
    const hostId = clients[0]!.identity.playerId;
    const clock = new FakeLifecycleScheduler();
    await restart({ lifecycleScheduler: clock });

    expect(projection().hostPlayerId).toBe(hostId);
    clock.advanceBy(60_000 - 1);
    await fixture!.server.settleLifecycle();
    expect(projection().hostPlayerId).toBe(hostId);

    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect(projection().hostPlayerId).toBeNull();
  });

  it("elects a player who reconnects before recovered host grace expires", async () => {
    const clients = await createSeatedPlayers();
    await startSession(clients, "startup-host-candidate");
    const oldHostId = clients[0]!.identity.playerId;
    const candidate = clients[1]!;
    const clock = new FakeLifecycleScheduler();
    await restart({ lifecycleScheduler: clock });

    clock.advanceBy(30_000);
    await fixture!.server.settleLifecycle();
    const reconnected = await connectWithCookie(fixture!, candidate.cookie);
    expect(findPublicPlayer(reconnected.initialProjection, candidate.identity.playerId)?.online).toBe(
      true,
    );
    expect(projection().hostPlayerId).toBe(oldHostId);

    clock.advanceBy(30_000);
    await fixture!.server.settleLifecycle();
    expect(projection().hostPlayerId).toBe(candidate.identity.playerId);
    expect(projection().status).toBe(TableLifecycleStatus.WaitingForFirstHand);
  });
});

describe("runtime version high-water recovery", () => {
  it("advances beyond repeated connection versions and rejects an old expectedVersion", async () => {
    const [host, player] = await createSeatedPlayers();
    await startSession([host!, player!], "connection-version");

    const firstOffline = waitForProjection(
      host!.socket,
      (state) => findPublicPlayer(state, player!.identity.playerId)?.online === false,
    );
    player!.socket.disconnect();
    await firstOffline;
    const reconnected = await connectWithCookie(fixture!, player!.cookie);
    const secondOffline = waitForProjection(
      host!.socket,
      (state) =>
        state.version > reconnected.initialProjection.version &&
        findPublicPlayer(state, player!.identity.playerId)?.online === false,
    );
    reconnected.socket.disconnect();
    const lastExposed = await secondOffline;

    const lastPreRestartVersion = projection().version;
    await restart();
    expect(lastPreRestartVersion).toBeGreaterThanOrEqual(lastExposed.version);
    expect(projection().version).toBeGreaterThan(lastPreRestartVersion);
    const restoredHost = await connectWithCookie(fixture!, host!.cookie);
    const stale = await executeSocketCommand(restoredHost.socket, {
      commandId: "old-version-after-restart",
      expectedVersion: lastExposed.version,
      command: {
        type: RuntimeCommandType.ChangeBlinds,
        smallBlind: 2,
        bigBlind: 4,
      },
    });
    expect(stale).toMatchObject({ status: "REJECTED", reason: "STALE_VERSION" });
  });
});

describe("durable command idempotency", () => {
  it("deduplicates replenishment and rejects a changed-payload collision after restart", async () => {
    const [host, player] = await createSeatedPlayers();
    await startSession([host!, player!], "replenish");
    const zeroed = await executeSocketCommand(
      host!.socket,
      nextCommand(host!.latestProjection, "zero-player", {
        type: RuntimeCommandType.HostAdjustChips,
        targetPlayerId: player!.identity.playerId,
        amount: -100,
        ledgerEntryId: "zero-player-ledger",
      }),
    );
    expect(zeroed.status).toBe("APPLIED");
    const input = {
      commandId: "durable-replenish",
      expectedVersion: zeroed.version,
      command: { type: "REPLENISH" },
    } as const;
    const applied = await executeSocketCommand(player!.socket, input);
    expect(applied.status).toBe("APPLIED");
    expect(findPublicPlayer(applied.projection, player!.identity.playerId)?.chipBalance).toBe(100);

    await restart();
    const restored = await connectWithCookie(fixture!, player!.cookie);
    const duplicate = await executeSocketCommand(restored.socket, input);
    expect(duplicate.status).toBe("DUPLICATE");
    expect(findPublicPlayer(duplicate.projection, player!.identity.playerId)?.chipBalance).toBe(100);

    const collision = await executeSocketCommand(restored.socket, {
      ...input,
      command: { type: "STAND_TO_SPECTATE" },
    });
    expect(collision).toMatchObject({ status: "REJECTED", reason: "INVALID_COMMAND" });
  });

  it("deduplicates a host chip adjustment after restart", async () => {
    const [host, player] = await createSeatedPlayers();
    await startSession([host!, player!], "adjust");
    const input = nextCommand(host!.latestProjection, "durable-host-adjust", {
      type: RuntimeCommandType.HostAdjustChips,
      targetPlayerId: player!.identity.playerId,
      amount: 17,
      ledgerEntryId: "durable-adjust-ledger",
    });
    const applied = await executeSocketCommand(host!.socket, input);
    expect(applied.status).toBe("APPLIED");

    await restart();
    const restored = await connectWithCookie(fixture!, host!.cookie);
    const duplicate = await executeSocketCommand(restored.socket, input);
    expect(duplicate.status).toBe("DUPLICATE");
    expect(findPublicPlayer(duplicate.projection, player!.identity.playerId)?.chipBalance).toBe(117);
    expect(
      duplicate.projection.session?.ledger.filter(
        (entry) =>
          entry.playerId === player!.identity.playerId &&
          entry.type === "HOST_ADJUSTMENT" &&
          entry.amount === 17,
      ),
    ).toHaveLength(1);
  });

  it("deduplicates first-Session SIT enrichment after restart", async () => {
    const players = await createSeatedPlayers();
    await startSession(players, "sit");
    const spectator = await createConnectedClient(fixture!, "LateSeat", { kind: "SPECTATOR" });
    const input = nextCommand(spectator.latestProjection, "durable-sit", {
      type: RuntimeCommandType.Sit,
      seat: 2,
    });
    const applied = await executeSocketCommand(spectator.socket, input);
    expect(applied.status).toBe("APPLIED");
    expect(findPublicPlayer(applied.projection, spectator.identity.playerId)?.chipBalance).toBe(100);

    await restart();
    const restored = await connectWithCookie(fixture!, spectator.cookie);
    const duplicate = await executeSocketCommand(restored.socket, input);
    expect(duplicate.status).toBe("DUPLICATE");
    expect(findPublicPlayer(duplicate.projection, spectator.identity.playerId)).toMatchObject({
      seat: 2,
      chipBalance: 100,
    });
    expect(
      duplicate.projection.session?.ledger.filter(
        (entry) => entry.playerId === spectator.identity.playerId && entry.type === "INITIAL_GRANT",
      ),
    ).toEqual([
      expect.objectContaining({
        ledgerEntryId: clientSitInitialGrantLedgerEntryId(
          spectator.identity.playerId,
          input.commandId,
        ),
      }),
    ]);

    const collision = await executeSocketCommand(restored.socket, {
      ...input,
      command: { type: RuntimeCommandType.Sit, seat: 3 },
    });
    expect(collision).toMatchObject({ status: "REJECTED", reason: "INVALID_COMMAND" });
  });
});

describe("durable identities", () => {
  it("commits simultaneous HTTP identity entries serially and restores both", async () => {
    const host = await createSeatedPlayers(1);
    await startSession(host, "concurrent-entry");
    const [left, right] = await Promise.all([
      enterIdentity(fixture!, "ConcLeft", { kind: "SEAT", seat: 1 }),
      enterIdentity(fixture!, "ConcRight", { kind: "SEAT", seat: 2 }),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    expect(projection().session?.ledger).toHaveLength(3);

    await restart();
    const restored = await Promise.all([
      connectWithCookie(fixture!, left.cookie!),
      connectWithCookie(fixture!, right.cookie!),
    ]);
    expect(restored.map(({ initialProjection }) => initialProjection.session?.ledger.length)).toEqual([
      3,
      3,
    ]);
    expect(
      new Set(
        projection().session?.ledger.map((entry) => entry.ledgerEntryId),
      ).size,
    ).toBe(3);
  });

  it("stores only a credential digest and restores the same active identity", async () => {
    const rawCredential = "known-high-entropy-recovery-credential-000000000001";
    await fixture!.close();
    factory = persistentFixtureFactory(databasePath(temporaryRoot), {
      credentials: [rawCredential],
    });
    fixture = await factory.start();
    const entered = await enterIdentity(fixture, "DigestUser", { kind: "SEAT", seat: 0 });
    expect(entered.status).toBe(201);
    const playerId = (entered.body as { playerId: string }).playerId;
    await fixture.close();
    fixture = undefined;

    const contents = await readFile(factory.databasePath);
    expect(contents.includes(Buffer.from(rawCredential))).toBe(false);
    expect(contents.includes(Buffer.from(recoveryCredentialDigest(rawCredential)))).toBe(true);
    const repository = new PrismaPersistenceRepository(factory.databaseUrl);
    await repository.connect();
    const recovered = await repository.loadOrBootstrap();
    await repository.close();
    expect(recovered.identities).toContainEqual(
      expect.objectContaining({
        playerId,
        nickname: "DigestUser",
        credentialDigest: recoveryCredentialDigest(rawCredential),
      }),
    );

    fixture = await factory.start();
    const connected = await connectWithCookie(fixture, entered.cookie!);
    expect(findPublicPlayer(connected.initialProjection, playerId)).toMatchObject({
      playerId,
      nickname: "DigestUser",
    });
    expect(JSON.stringify(connected.initialProjection)).not.toContain(rawCredential);
    expect(JSON.stringify(connected.initialProjection)).not.toContain(
      recoveryCredentialDigest(rawCredential),
    );
  });

  it("keeps kick revocation durable and re-enters without a second initial grant", async () => {
    const [host, target] = await createSeatedPlayers();
    await startSession([host!, target!], "kick");
    const kicked = await executeSocketCommand(
      host!.socket,
      nextCommand(host!.latestProjection, "durable-kick", {
        type: RuntimeCommandType.Kick,
        targetPlayerId: target!.identity.playerId,
      }),
    );
    expect(kicked.status).toBe("APPLIED");
    await restart();

    expect(await expectConnectionError(fixture!, target!.cookie)).toBe("AUTH_REQUIRED");
    const reentered = await enterIdentity(
      fixture!,
      "Persist2",
      { kind: "SEAT", seat: 1 },
      { reenterAfterKick: true },
    );
    expect(reentered.status).toBe(200);
    expect((reentered.body as { playerId: string }).playerId).toBe(target!.identity.playerId);
    expect(reentered.cookie).not.toBe(target!.cookie);
    const connected = await connectWithCookie(fixture!, reentered.cookie!);
    expect(findPublicPlayer(connected.initialProjection, target!.identity.playerId)?.chipBalance).toBe(
      100,
    );
    expect(
      connected.initialProjection.session?.ledger.filter(
        (entry) => entry.playerId === target!.identity.playerId && entry.type === "INITIAL_GRANT",
      ),
    ).toHaveLength(1);
  });

  it("persists Session-end invalidation and resets nickname uniqueness", async () => {
    const clients = await createSeatedPlayers();
    await startSession(clients, "end");
    const prepared = await executeSocketCommand(
      clients[0]!.socket,
      nextCommand(clients[0]!.latestProjection, "prepare-durable-end", {
        type: RuntimeCommandType.PrepareEndSession,
      }),
    );
    const data = (prepared as CommandExecutionSuccess).data;
    if (data.kind !== "SESSION_END_PREVIEW") throw new Error("Missing end preview");
    const ended = await executeSocketCommand(clients[0]!.socket, {
      commandId: "durable-end",
      expectedVersion: prepared.version,
      command: { type: RuntimeCommandType.EndSession, confirmation: data.preview },
    });
    expect(ended.status).toBe("APPLIED");
    const oldCookies = clients.map((client) => client.cookie);
    await restart();

    for (const cookie of oldCookies) {
      expect(await expectConnectionError(fixture!, cookie)).toBe("AUTH_REQUIRED");
    }
    const next = await enterIdentity(fixture!, "Persist1", { kind: "SEAT", seat: 0 });
    expect(next.status).toBe(201);
    expect((next.body as { playerId: string }).playerId).not.toBe(clients[0]!.identity.playerId);
  });
});

describe("corruption and schema-version handling", () => {
  it.each([
    ["unknown schema", { snapshotSchema: 999 }],
    ["malformed snapshot", { snapshotJson: "{not-json" }],
  ])("fails startup for %s", async (_label, data) => {
    await fixture!.close();
    fixture = undefined;
    const prisma = new PrismaClient({ datasourceUrl: factory.databaseUrl });
    await prisma.applicationState.update({ where: { id: 1 }, data });
    await prisma.$disconnect();

    await expect(
      createPersistentPokerServer({
        databaseUrl: factory.databaseUrl,
        allowedOrigins: ["http://test.friend-poker.local"],
      }),
    ).rejects.toThrow(/snapshot|schema|JSON/iu);
  });
});
