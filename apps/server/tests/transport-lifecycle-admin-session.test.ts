import { afterEach, describe, expect, it } from "vitest";

import { PlayerActionType, TableLifecycleStatus } from "@friend-poker/poker-engine";
import {
  CommandRejectionReason,
  RuntimeCommandType,
  TransportEvent,
} from "../src/index.js";
import type {
  CommandExecutionSuccess,
  SafeTableProjection,
} from "../src/index.js";
import { FakeLifecycleScheduler } from "./fake-lifecycle-scheduler.js";
import type {
  ConnectedClient,
  TransportFixture,
} from "./transport-helpers.js";
import {
  createConnectedClient,
  createTransportFixture,
  connectWithCookie,
  enterIdentity,
  executeSocketCommand,
  expectConnectionError,
  findPublicPlayer,
  nextCommand,
  synchronizeClients,
  waitForDisconnect,
  waitForProjection,
} from "./transport-helpers.js";

let fixture: TransportFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function projection(): SafeTableProjection {
  return fixture!.server.runtime.getProjection({ kind: "SPECTATOR" });
}

async function settleUntilAllOffline(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await fixture!.server.settleLifecycle();
    const players = [
      ...projection().seats.filter((player) => player !== null),
      ...projection().spectators,
    ];
    if (players.every((player) => !player.online)) return;
  }
  throw new Error("Socket disconnects did not reach authoritative offline state");
}

async function syncConnectedToServer(clients: readonly ConnectedClient[]): Promise<void> {
  const version = projection().version;
  await Promise.all(
    clients
      .filter((client) => client.socket.connected)
      .map((client) =>
        client.latestProjection.version >= version
          ? Promise.resolve(client.latestProjection)
          : waitForProjection(client.socket, (state) => state.version >= version),
      ),
  );
}

async function createPlayers(
  clock: FakeLifecycleScheduler,
  count = 3,
  options: {
    readonly disconnectedTurnTimeoutMs?: number;
    readonly allOfflineTimeoutMs?: number;
  } = {},
): Promise<readonly ConnectedClient[]> {
  fixture = await createTransportFixture({
    lifecycleScheduler: clock,
    ...options,
  });
  const clients: ConnectedClient[] = [];
  for (let index = 0; index < count; index += 1) {
    clients.push(
      await createConnectedClient(fixture, `Admin${index + 1}`, {
        kind: "SEAT",
        seat: index as 0 | 1 | 2,
      }),
    );
  }
  await synchronizeClients(clients);
  return clients;
}

async function startSession(clients: readonly ConnectedClient[]): Promise<void> {
  const result = await executeSocketCommand(
    clients[0]!.socket,
    nextCommand(clients[0]!.latestProjection, "admin-session", {
      type: RuntimeCommandType.StartSession,
      sessionId: "admin-session",
      initialGrants: clients.map((client) => ({
        playerId: client.identity.playerId,
        ledgerEntryId: `initial-${client.identity.playerId}`,
      })),
    }),
  );
  expect(result.status).toBe("APPLIED");
  await synchronizeClients(clients);
}

async function startHand(clients: readonly ConnectedClient[]): Promise<void> {
  const result = await executeSocketCommand(
    clients[0]!.socket,
    nextCommand(clients[0]!.latestProjection, "admin-hand", {
      type: RuntimeCommandType.StartFirstHand,
      handId: "admin-hand",
      buttonSeat: 0,
    }),
  );
  expect(result.status).toBe("APPLIED");
  await synchronizeClients(clients);
}

describe("host leave, kick, and force-Fold over real Socket.IO", () => {
  it("transfers immediately on explicit host leave without a grace timer", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock);
    const host = clients[0]!;
    const left = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "host-leave", {
        type: RuntimeCommandType.LeaveTable,
      }),
    );
    expect(left.status).toBe("APPLIED");
    await waitForDisconnect(host.socket);
    await fixture!.server.settleLifecycle();
    expect(projection().hostPlayerId).toBe(clients[1]!.identity.playerId);
    expect(clock.now()).toBe(0);
  });

  it("administratively folds an explicit in-hand leaver and releases the seat", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock);
    await startSession(clients);
    await startHand(clients);
    const leaver = clients[1]!;
    const disconnected = waitForDisconnect(leaver.socket);
    const left = await executeSocketCommand(
      leaver.socket,
      nextCommand(leaver.latestProjection, "in-hand-leave", {
        type: RuntimeCommandType.LeaveTable,
      }),
    );
    expect(left.status).toBe("APPLIED");
    await disconnected;

    if (projection().currentHand !== null) {
      await syncConnectedToServer(clients);
      const actorId = projection().currentHand!.currentActorId!;
      const actor = byPlayerId(clients, actorId);
      const finished = await executeSocketCommand(
        actor.socket,
        nextCommand(actor.latestProjection, "finish-after-leave", {
          type: RuntimeCommandType.PokerAction,
          action: { type: PlayerActionType.Fold },
        }),
      );
      expect(finished.status).toBe("APPLIED");
    }
    expect(projection().status).toBe(TableLifecycleStatus.BetweenHands);
    expect(findPublicPlayer(projection(), leaver.identity.playerId)).toBeUndefined();
    expect(projection().recentHands[0]!.record.events).toContainEqual(
      expect.objectContaining({
        type: "ADMINISTRATIVE_FOLD",
        reason: "EXPLICIT_LEAVE",
        targetPlayerId: leaver.identity.playerId,
      }),
    );
  });

  it("kicks and administratively folds an in-hand participant without leaking cards", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock);
    await startSession(clients);
    await startHand(clients);
    const host = clients[0]!;
    const target = clients[1]!;
    const targetInHand = projection().currentHand!.participants.find(
      (participant) => participant.playerId === target.identity.playerId,
    )!;
    const disconnected = waitForDisconnect(target.socket);
    const kicked = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "in-hand-kick", {
        type: RuntimeCommandType.Kick,
        targetPlayerId: target.identity.playerId,
      }),
    );
    expect(kicked.status).toBe("APPLIED");
    await disconnected;
    expect(await expectConnectionError(fixture!, target.cookie)).toBe("AUTH_REQUIRED");

    const publicTarget = findPublicPlayer(projection(), target.identity.playerId);
    if (projection().currentHand !== null) {
      const folded = projection().currentHand!.participants.find(
        (participant) => participant.playerId === target.identity.playerId,
      )!;
      expect(folded).toMatchObject({
        folded: true,
        totalContribution: targetInHand.totalContribution,
      });
      expect(publicTarget).toMatchObject({ pendingLeaveAfterHand: true, present: false });
      await syncConnectedToServer(clients);
      const actorId = projection().currentHand!.currentActorId!;
      const actor = byPlayerId(clients, actorId);
      await executeSocketCommand(
        actor.socket,
        nextCommand(actor.latestProjection, "finish-after-kick", {
          type: RuntimeCommandType.PokerAction,
          action: { type: PlayerActionType.Fold },
        }),
      );
    }
    const serialized = JSON.stringify(kicked.projection);
    expect(serialized).not.toMatch(
      /remainingDeck|privateHoleCards|activeHand|bettingState|credential|cookie|secret/iu,
    );
    const reentered = await enterIdentity(
      fixture!,
      "Admin2",
      { kind: "SEAT", seat: 1 },
      { reenterAfterKick: true },
    );
    expect(reentered.status).toBe(200);
    expect((reentered.body as { playerId: string }).playerId).toBe(target.identity.playerId);
    expect(reentered.cookie).not.toBe(target.cookie);
    expect(
      projection().session?.ledger.filter(
        (entry) =>
          entry.playerId === target.identity.playerId && entry.type === "INITIAL_GRANT",
      ),
    ).toHaveLength(1);
  });

  it("allows only the host to force-Fold the current actor and deduplicates retries", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock);
    await startSession(clients);
    await startHand(clients);
    const host = clients[0]!;
    const actorId = projection().currentHand!.currentActorId!;
    const nonHost = clients.find((client) => client !== host)!;
    const rejected = await executeSocketCommand(
      nonHost.socket,
      nextCommand(nonHost.latestProjection, "nonhost-force-fold", {
        type: RuntimeCommandType.HostForceFold,
        targetPlayerId: actorId,
      }),
    );
    expect(rejected).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.UnauthorizedIdentity,
    });

    const envelope = nextCommand(host.latestProjection, "host-force-fold", {
      type: RuntimeCommandType.HostForceFold,
      targetPlayerId: actorId,
    });
    const applied = await executeSocketCommand(host.socket, envelope);
    const duplicate = await executeSocketCommand(host.socket, envelope);
    expect(applied.status).toBe("APPLIED");
    expect(duplicate.status).toBe("DUPLICATE");
    if (projection().currentHand !== null) {
      await syncConnectedToServer(clients);
      const nextActorId = projection().currentHand!.currentActorId!;
      const nextActor = byPlayerId(clients, nextActorId);
      await executeSocketCommand(
        nextActor.socket,
        nextCommand(nextActor.latestProjection, "finish-after-force", {
          type: RuntimeCommandType.PokerAction,
          action: { type: PlayerActionType.Fold },
        }),
      );
    }
    expect(projection().recentHands.at(-1)!.record.events).toContainEqual(
      expect.objectContaining({
        type: "ADMINISTRATIVE_FOLD",
        reason: "HOST_FORCE_FOLD",
        operatorPlayerId: host.identity.playerId,
      }),
    );
  });

  it("rejects every trusted lifecycle command submitted by a browser", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock);
    await startSession(clients);
    await startHand(clients);
    const player = clients[0]!;
    const actorId = projection().currentHand!.currentActorId!;
    for (const [index, command] of [
      {
        type: RuntimeCommandType.AdministrativeFold,
        targetPlayerId: actorId,
        reason: "DISCONNECT_TIMEOUT",
      },
      { type: RuntimeCommandType.SetLifecycleHost, targetPlayerId: player.identity.playerId },
      { type: RuntimeCommandType.AutoEndSession },
      { type: RuntimeCommandType.AdvanceRunout },
    ].entries()) {
      const result = await executeSocketCommand(
        player.socket,
        nextCommand(player.latestProjection, `trusted-command-${index}`, command as never),
      );
      expect(result).toMatchObject({
        status: "REJECTED",
        reason: CommandRejectionReason.UnauthorizedIdentity,
      });
    }
  });
});

describe("all-offline Session boundary and entry concurrency", () => {
  it("revokes and disconnects connected identities after manual Session end", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock, 2);
    await startSession(clients);
    const host = clients[0]!;
    const prepared = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "prepare-manual-end", {
        type: RuntimeCommandType.PrepareEndSession,
      }),
    );
    expect(prepared.status).toBe("NO_OP");
    const preview = (prepared as CommandExecutionSuccess).data;
    if (preview.kind !== "SESSION_END_PREVIEW") throw new Error("Missing Session end preview");
    const revoked = clients.map(
      (client) =>
        new Promise<string>((resolve) =>
          client.socket.once(TransportEvent.IdentityRevoked, ({ reason }) => resolve(reason)),
        ),
    );
    const disconnected = clients.map((client) => waitForDisconnect(client.socket));
    const ended = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "manual-end", {
        type: RuntimeCommandType.EndSession,
        confirmation: preview.preview,
      }),
    );
    expect(ended.status).toBe("APPLIED");
    expect(await Promise.all(revoked)).toEqual(["SESSION_ENDED", "SESSION_ENDED"]);
    await Promise.all(disconnected);
    expect(await expectConnectionError(fixture!, host.cookie)).toBe("AUTH_REQUIRED");
  });

  it("waits 30 continuous minutes, ends between hands, and invalidates old identities", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock, 2);
    await startSession(clients);
    const oldId = clients[0]!.identity.playerId;
    const oldCookie = clients[0]!.cookie;
    for (const client of clients) client.socket.disconnect();
    await Promise.all(clients.map((client) => waitForDisconnect(client.socket)));
    await settleUntilAllOffline();

    clock.advanceBy(30 * 60_000 - 1);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.WaitingForFirstHand);
    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.SessionEnded);
    expect(projection().recentSessions).toHaveLength(1);
    expect(projection().hostPlayerId).toBeNull();
    expect(projection().seats.every((seat) => seat === null)).toBe(true);
    expect(await expectConnectionError(fixture!, oldCookie)).toBe("AUTH_REQUIRED");

    const next = await enterIdentity(
      fixture!,
      "Admin1",
      { kind: "SEAT", seat: 0 },
      { cookie: oldCookie },
    );
    expect(next.status).toBe(201);
    const nextHostId = (next.body as { playerId: string }).playerId;
    expect(nextHostId).not.toBe(oldId);
    const nextHost = await connectWithCookie(fixture!, next.cookie!);
    const second = await enterIdentity(fixture!, "Admin2", {
      kind: "SEAT",
      seat: 1,
    });
    expect(second.status).toBe(201);
    await connectWithCookie(fixture!, second.cookie!);
    const currentVersion = projection().version;
    const hostState =
      nextHost.initialProjection.version >= currentVersion
        ? nextHost.initialProjection
        : await waitForProjection(
            nextHost.socket,
            (state) => state.version >= currentVersion,
          );
    const started = await executeSocketCommand(
      nextHost.socket,
      nextCommand(hostState, "next-session", {
        type: RuntimeCommandType.StartSession,
        sessionId: "next-session",
        initialGrants: [nextHostId, (second.body as { playerId: string }).playerId].map(
          (playerId) => ({ playerId, ledgerEntryId: `next-initial-${playerId}` }),
        ),
      }),
    );
    expect(started.status).toBe("APPLIED");
    expect(projection().session?.ledger).toHaveLength(2);
    expect(projection().recentSessions).toHaveLength(1);
  });

  it("cancels the all-offline deadline when any player reconnects", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock, 2);
    await startSession(clients);
    for (const client of clients) client.socket.disconnect();
    await settleUntilAllOffline();
    clock.advanceBy(30 * 60_000 - 1);
    const restored = await createConnectedClientFromExisting(clients[0]!);
    expect(restored.ownHoleCards).toBeNull();
    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.WaitingForFirstHand);
  });

  it("marks a mid-hand deadline pending, then ends after timeout Fold completes the hand", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await createPlayers(clock, 2, {
      disconnectedTurnTimeoutMs: 31 * 60_000,
    });
    await startSession(clients);
    await startHand(clients);
    for (const client of clients) client.socket.disconnect();
    await settleUntilAllOffline();

    clock.advanceBy(30 * 60_000);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.HandInProgress);
    clock.advanceBy(60_000);
    await fixture!.server.settleLifecycle();
    expect(projection().status).toBe(TableLifecycleStatus.SessionEnded);
    expect(projection().recentHands).toHaveLength(1);
    expect(projection().recentSessions).toHaveLength(1);
  });

  it("retries simultaneous HTTP entries without duplicate identities or initial grants", async () => {
    const clock = new FakeLifecycleScheduler();
    fixture = await createTransportFixture({ lifecycleScheduler: clock });
    const host = await createConnectedClient(fixture, "CHost", {
      kind: "SEAT",
      seat: 0,
    });
    await startSession([host]);

    const [left, right] = await Promise.all([
      enterIdentity(fixture, "ConcurrentA", { kind: "SEAT", seat: 1 }),
      enterIdentity(fixture, "ConcurrentB", { kind: "SEAT", seat: 2 }),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    expect((left.body as { playerId: string }).playerId).not.toBe(
      (right.body as { playerId: string }).playerId,
    );
    const ledger = projection().session!.ledger;
    expect(ledger).toHaveLength(3);
    expect(new Set(ledger.map((entry) => entry.ledgerEntryId)).size).toBe(3);
    expect(fixture.issuedCredentials).toHaveLength(3);
  });
});

async function createConnectedClientFromExisting(
  client: ConnectedClient,
): Promise<SafeTableProjection> {
  const socket = await connectWithCookie(fixture!, client.cookie);
  return socket.initialProjection;
}

function byPlayerId(
  clients: readonly ConnectedClient[],
  playerId: string,
): ConnectedClient {
  const client = clients.find((candidate) => candidate.identity.playerId === playerId);
  if (client === undefined) throw new Error(`Missing connected client ${playerId}`);
  return client;
}
