import { afterEach, describe, expect, it } from "vitest";

import { PlayerActionType } from "@friend-poker/poker-engine";
import { RuntimeCommandType } from "../src/index.js";
import type { SafeTableProjection } from "../src/index.js";
import { FakeLifecycleScheduler } from "./fake-lifecycle-scheduler.js";
import type {
  ConnectedClient,
  TransportFixture,
} from "./transport-helpers.js";
import {
  connectWithCookie,
  createConnectedClient,
  createTransportFixture,
  executeSocketCommand,
  findPublicPlayer,
  nextCommand,
  synchronizeClients,
  waitForProjection,
} from "./transport-helpers.js";

let fixture: TransportFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function startedHand(
  clock: FakeLifecycleScheduler,
  playerCount = 3,
  hostSeat: 0 | 1 | 2 = 0,
): Promise<readonly ConnectedClient[]> {
  fixture = await createTransportFixture({ lifecycleScheduler: clock });
  const clients: ConnectedClient[] = [];
  const seats = [hostSeat, ...([0, 1, 2] as const).filter((seat) => seat !== hostSeat)];
  for (let index = 0; index < playerCount; index += 1) {
    clients.push(
      await createConnectedClient(fixture, `Player${index + 1}`, {
        kind: "SEAT",
        seat: seats[index]!,
      }),
    );
  }
  await synchronizeClients(clients);
  const host = clients[0]!;
  const session = await executeSocketCommand(
    host.socket,
    nextCommand(host.latestProjection, "lifecycle-session", {
      type: RuntimeCommandType.StartSession,
      sessionId: "lifecycle-session",
      initialGrants: clients.map((client) => ({
        playerId: client.identity.playerId,
        ledgerEntryId: `initial-${client.identity.playerId}`,
      })),
    }),
  );
  expect(session.status).toBe("APPLIED");
  await synchronizeClients(clients);
  const hand = await executeSocketCommand(
    host.socket,
    nextCommand(host.latestProjection, "lifecycle-hand", {
      type: "START_FIRST_HAND",
    }),
  );
  expect(hand.status).toBe("APPLIED");
  await synchronizeClients(clients);
  return clients;
}

function serverProjection(): SafeTableProjection {
  return fixture!.server.runtime.getProjection({ kind: "SPECTATOR" });
}

function clientForPlayer(
  clients: readonly ConnectedClient[],
  playerId: string,
): ConnectedClient {
  return clients.find((client) => client.identity.playerId === playerId)!;
}

describe("deterministic disconnected-turn lifecycle", () => {
  it("waits through 59.999 seconds and folds exactly once at 60 seconds", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock);
    const actorId = serverProjection().currentHand!.currentActorId!;
    const actor = clientForPlayer(clients, actorId);
    const observer = clients.find((client) => client !== actor)!;
    const offline = waitForProjection(
      observer.socket,
      (projection) => findPublicPlayer(projection, actorId)?.online === false,
    );
    actor.socket.disconnect();
    await offline;
    await fixture!.server.settleLifecycle();

    clock.advanceBy(59_999);
    await fixture!.server.settleLifecycle();
    expect(
      serverProjection().currentHand!.participants.find(
        (participant) => participant.playerId === actorId,
      )!.folded,
    ).toBe(false);

    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    const after = serverProjection();
    expect(
      after.currentHand!.participants.find(
        (participant) => participant.playerId === actorId,
      )!.folded,
    ).toBe(true);
    const version = after.version;
    clock.advanceBy(60_000);
    await fixture!.server.settleLifecycle();
    expect(serverProjection().version).toBe(version);
  });

  it("cancels the Fold when the same identity reconnects at 59 seconds", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock);
    const actorId = serverProjection().currentHand!.currentActorId!;
    const actor = clientForPlayer(clients, actorId);
    actor.socket.disconnect();
    await waitForProjection(
      clients.find((client) => client !== actor)!.socket,
      (projection) => findPublicPlayer(projection, actorId)?.online === false,
    );
    await fixture!.server.settleLifecycle();

    clock.advanceBy(59_000);
    const reconnected = await connectWithCookie(fixture!, actor.cookie);
    expect(reconnected.initialProjection.ownHoleCards).toEqual(
      actor.latestProjection.ownHoleCards,
    );
    clock.advanceBy(1_000);
    await fixture!.server.settleLifecycle();
    expect(
      serverProjection().currentHand!.participants.find(
        (participant) => participant.playerId === actorId,
      )!.folded,
    ).toBe(false);
    expect(serverProjection().hostPlayerId).toBe(clients[0]!.identity.playerId);
  });

  it("starts a fresh 60-second window when an already-offline player's turn arrives", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock);
    const nextActor = clients[1]!;
    const offline = waitForProjection(
      clients[0]!.socket,
      (projection) =>
        findPublicPlayer(projection, nextActor.identity.playerId)?.online === false,
    );
    nextActor.socket.disconnect();
    await offline;
    await fixture!.server.settleLifecycle();
    clock.advanceBy(30_000);

    const currentActorId = serverProjection().currentHand!.currentActorId!;
    const currentActor = clientForPlayer(clients, currentActorId);
    await executeSocketCommand(
      currentActor.socket,
      nextCommand(currentActor.latestProjection, "advance-to-offline-player", {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.Call },
      }),
    );
    await fixture!.server.settleLifecycle();
    expect(serverProjection().currentHand?.currentActorId).toBe(nextActor.identity.playerId);

    clock.advanceBy(59_999);
    await fixture!.server.settleLifecycle();
    expect(
      serverProjection().currentHand!.participants.find(
        (participant) => participant.playerId === nextActor.identity.playerId,
      )!.folded,
    ).toBe(false);
    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect(
      serverProjection().currentHand!.participants.find(
        (participant) => participant.playerId === nextActor.identity.playerId,
      )!.folded,
    ).toBe(true);
  });

  it("cancels a disconnected-turn timer after host force-Fold and cannot affect the next hand", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock, 3, 1);
    const host = clients[0]!;
    const actorId = serverProjection().currentHand!.currentActorId!;
    expect(actorId).not.toBe(host.identity.playerId);
    const actor = clientForPlayer(clients, actorId);
    const hostUpdated = waitForProjection(
      host.socket,
      (state) => findPublicPlayer(state, actorId)?.online === false,
    );
    actor.socket.disconnect();
    await hostUpdated;
    await fixture!.server.settleLifecycle();

    const forced = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "force-before-timeout", {
        type: RuntimeCommandType.HostForceFold,
        targetPlayerId: actorId,
      }),
    );
    expect(forced.status).toBe("APPLIED");

    if (serverProjection().currentHand !== null) {
      const nextActorId = serverProjection().currentHand!.currentActorId!;
      const nextActor = clientForPlayer(clients, nextActorId);
      const actorState =
        nextActor.latestProjection.version >= serverProjection().version
          ? nextActor.latestProjection
          : await waitForProjection(
              nextActor.socket,
              (state) => state.version >= serverProjection().version,
            );
      await executeSocketCommand(
        nextActor.socket,
        nextCommand(actorState, "finish-old-hand", {
          type: RuntimeCommandType.PokerAction,
          action: { type: PlayerActionType.Fold },
        }),
      );
    }
    expect(serverProjection().currentHand).toBeNull();
    const hostState =
      host.latestProjection.version >= serverProjection().version
        ? host.latestProjection
        : await waitForProjection(
            host.socket,
            (state) => state.version >= serverProjection().version,
          );
    const nextHand = await executeSocketCommand(
      host.socket,
      nextCommand(hostState, "new-hand-after-stale-timer", {
        type: RuntimeCommandType.StartNextHand,
        handId: "lifecycle-hand-2",
      }),
    );
    expect(nextHand.status).toBe("APPLIED");
    const newHandVersion = serverProjection().version;
    clock.advanceBy(60_000);
    await fixture!.server.settleLifecycle();
    expect(serverProjection().currentHand?.handId).toContain("new-hand-after-stale-timer");
    expect(serverProjection().version).toBe(newHandVersion);
  });

  it("cancels a disconnected-turn timer when the actor is kicked", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock, 3, 1);
    const host = clients[0]!;
    const actorId = serverProjection().currentHand!.currentActorId!;
    const actor = clientForPlayer(clients, actorId);
    expect(actor).not.toBe(host);
    const offline = waitForProjection(
      host.socket,
      (state) => findPublicPlayer(state, actorId)?.online === false,
    );
    actor.socket.disconnect();
    await offline;
    await fixture!.server.settleLifecycle();
    const kicked = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "kick-before-timeout", {
        type: RuntimeCommandType.Kick,
        targetPlayerId: actorId,
      }),
    );
    expect(kicked.status).toBe("APPLIED");
    const version = serverProjection().version;
    clock.advanceBy(60_000);
    await fixture!.server.settleLifecycle();
    expect(serverProjection().version).toBe(version);
  });

  it("cancels every owned timer when the server closes", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock);
    const actorId = serverProjection().currentHand!.currentActorId!;
    const actor = clientForPlayer(clients, actorId);
    const offline = waitForProjection(
      clients.find((client) => client !== actor)!.socket,
      (state) => findPublicPlayer(state, actorId)?.online === false,
    );
    actor.socket.disconnect();
    await offline;
    await fixture!.server.settleLifecycle();
    expect(clock.pendingCount).toBeGreaterThan(0);
    await fixture!.server.close();
    expect(clock.pendingCount).toBe(0);
    fixture = undefined;
  });
});

describe("deterministic host grace and paced Runout", () => {
  it("retains the host before 60 seconds and uses lexical playerId for an exact tie", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock);
    const host = clients[0]!;
    const expectedNewHost = clients[1]!;
    host.socket.disconnect();
    await waitForProjection(
      expectedNewHost.socket,
      (projection) => findPublicPlayer(projection, host.identity.playerId)?.online === false,
    );
    await fixture!.server.settleLifecycle();

    clock.advanceBy(59_999);
    await fixture!.server.settleLifecycle();
    expect(serverProjection().hostPlayerId).toBe(host.identity.playerId);
    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect(serverProjection().hostPlayerId).toBe(expectedNewHost.identity.playerId);

    await connectWithCookie(fixture!, host.cookie);
    expect(serverProjection().hostPlayerId).toBe(expectedNewHost.identity.playerId);
  });

  it("prefers seated players over longer-online spectators", async () => {
    const clock = new FakeLifecycleScheduler();
    fixture = await createTransportFixture({ lifecycleScheduler: clock });
    const host = await createConnectedClient(fixture, "Host", { kind: "SPECTATOR" });
    clock.advanceBy(10);
    const spectator = await createConnectedClient(fixture, "Watcher", {
      kind: "SPECTATOR",
    });
    clock.advanceBy(10);
    const seated = await createConnectedClient(fixture, "Seated", {
      kind: "SEAT",
      seat: 0,
    });
    host.socket.disconnect();
    await waitForProjection(
      spectator.socket,
      (state) => findPublicPlayer(state, host.identity.playerId)?.online === false,
    );
    await fixture.server.settleLifecycle();
    clock.advanceBy(60_000);
    await fixture.server.settleLifecycle();
    expect(serverProjection().hostPlayerId).toBe(seated.identity.playerId);
  });

  it("chooses the longest continuously online seated player", async () => {
    const clock = new FakeLifecycleScheduler();
    fixture = await createTransportFixture({ lifecycleScheduler: clock });
    const host = await createConnectedClient(fixture, "Host", {
      kind: "SEAT",
      seat: 0,
    });
    clock.advanceBy(10);
    const longest = await createConnectedClient(fixture, "Longest", {
      kind: "SEAT",
      seat: 1,
    });
    clock.advanceBy(10);
    const newer = await createConnectedClient(fixture, "Newer", {
      kind: "SEAT",
      seat: 2,
    });
    host.socket.disconnect();
    await waitForProjection(
      newer.socket,
      (state) => findPublicPlayer(state, host.identity.playerId)?.online === false,
    );
    await fixture.server.settleLifecycle();
    clock.advanceBy(60_000);
    await fixture.server.settleLifecycle();
    expect(serverProjection().hostPlayerId).toBe(longest.identity.playerId);
  });

  it("sets host null with no candidate and assigns the first later reconnect", async () => {
    const clock = new FakeLifecycleScheduler();
    fixture = await createTransportFixture({ lifecycleScheduler: clock });
    const host = await createConnectedClient(fixture, "OnlyHost", {
      kind: "SEAT",
      seat: 0,
    });
    host.socket.disconnect();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await fixture.server.settleLifecycle();
      if (serverProjection().seats[0]?.online === false) break;
    }
    expect(serverProjection().seats[0]?.online).toBe(false);
    clock.advanceBy(60_000);
    await fixture.server.settleLifecycle();
    expect(serverProjection().hostPlayerId).toBeNull();

    await connectWithCookie(fixture, host.cookie);
    expect(serverProjection().hostPlayerId).toBe(host.identity.playerId);
  });

  it("keeps a reconnected host within grace and preserves their explicit transfer", async () => {
    const clock = new FakeLifecycleScheduler();
    fixture = await createTransportFixture({ lifecycleScheduler: clock });
    const host = await createConnectedClient(fixture, "Host", {
      kind: "SEAT",
      seat: 0,
    });
    const target = await createConnectedClient(fixture, "Target", {
      kind: "SEAT",
      seat: 1,
    });
    host.socket.disconnect();
    await waitForProjection(
      target.socket,
      (state) => findPublicPlayer(state, host.identity.playerId)?.online === false,
    );
    await fixture.server.settleLifecycle();
    clock.advanceBy(59_000);
    const reconnected = await connectWithCookie(fixture, host.cookie);
    expect(serverProjection().hostPlayerId).toBe(host.identity.playerId);
    const transferred = await executeSocketCommand(
      reconnected.socket,
      nextCommand(reconnected.initialProjection, "explicit-host-transfer", {
        type: RuntimeCommandType.TransferHost,
        targetPlayerId: target.identity.playerId,
      }),
    );
    expect(transferred.status).toBe("APPLIED");
    clock.advanceBy(1_000);
    await fixture.server.settleLifecycle();
    expect(serverProjection().hostPlayerId).toBe(target.identity.playerId);
  });

  it("reveals Flop, Turn, and River in separately scheduled 750ms stages", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock, 2);
    let actorId = serverProjection().currentHand!.currentActorId!;
    let actor = clientForPlayer(clients, actorId);
    await executeSocketCommand(
      actor.socket,
      nextCommand(actor.latestProjection, "runout-all-in", {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.AllIn },
      }),
    );
    await synchronizeClients(clients);
    actorId = serverProjection().currentHand!.currentActorId!;
    actor = clientForPlayer(clients, actorId);
    const called = await executeSocketCommand(
      actor.socket,
      nextCommand(actor.latestProjection, "runout-call", {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.Call },
      }),
    );
    expect(called.status).toBe("APPLIED");
    expect(serverProjection().currentHand).toMatchObject({
      status: "RUNOUT_REQUIRED",
      board: [],
    });

    clock.advanceBy(749);
    await fixture!.server.settleLifecycle();
    expect(serverProjection().currentHand?.board).toHaveLength(0);
    const flop = waitForProjection(clients[0]!.socket, (projection) =>
      projection.currentHand?.board.length === 3,
    );
    clock.advanceBy(1);
    await fixture!.server.settleLifecycle();
    expect((await flop).currentHand?.board).toHaveLength(3);

    const turn = waitForProjection(clients[0]!.socket, (projection) =>
      projection.currentHand?.board.length === 4,
    );
    clock.advanceBy(750);
    await fixture!.server.settleLifecycle();
    expect((await turn).currentHand?.board).toHaveLength(4);

    const river = waitForProjection(
      clients[0]!.socket,
      (projection) => projection.currentHand === null && projection.recentHands.length === 1,
    );
    clock.advanceBy(750);
    await fixture!.server.settleLifecycle();
    expect((await river).recentHands[0]?.record.board).toHaveLength(5);
    expect(clock.pendingCount).toBe(0);
  });

  it("rechecks state when a cancelled Runout callback races with a new hand", async () => {
    const clock = new FakeLifecycleScheduler();
    const clients = await startedHand(clock, 3);
    let actorId = serverProjection().currentHand!.currentActorId!;
    let actor = clientForPlayer(clients, actorId);
    await executeSocketCommand(
      actor.socket,
      nextCommand(actor.latestProjection, "stale-runout-all-in", {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.AllIn },
      }),
    );
    await synchronizeClients(clients);
    actorId = serverProjection().currentHand!.currentActorId!;
    actor = clientForPlayer(clients, actorId);
    await executeSocketCommand(
      actor.socket,
      nextCommand(actor.latestProjection, "stale-runout-call", {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.Call },
      }),
    );
    await synchronizeClients(clients);
    actorId = serverProjection().currentHand!.currentActorId!;
    actor = clientForPlayer(clients, actorId);
    await executeSocketCommand(
      actor.socket,
      nextCommand(actor.latestProjection, "stale-runout-fold", {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.Fold },
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await fixture!.server.settleLifecycle();
    expect(serverProjection().currentHand?.status).toBe("RUNOUT_REQUIRED");

    for (let stage = 0; stage < 3; stage += 1) {
      const result = await fixture!.server.runtime.execute(
        { kind: "SYSTEM", systemId: "test-runout" },
        {
          commandId: `direct-runout-${stage}`,
          actorId: "test-runout",
          expectedVersion: fixture!.server.runtime.version,
          command: { type: RuntimeCommandType.AdvanceRunout },
        },
      );
      expect(result.status).toBe("APPLIED");
    }
    await fixture!.server.settleLifecycle();
    const host = clients[0]!;
    const hostState = fixture!.server.runtime.getProjection({
      kind: "PLAYER",
      playerId: host.identity.playerId,
    });
    const started = await executeSocketCommand(
      host.socket,
      nextCommand(hostState, "hand-after-cancelled-runout", {
        type: RuntimeCommandType.StartNextHand,
        handId: "hand-after-cancelled-runout",
      }),
    );
    expect(started.status).toBe("APPLIED");
    const version = serverProjection().version;
    clock.fireCancelledCallbacks();
    await fixture!.server.settleLifecycle();
    expect(serverProjection().currentHand?.handId).toContain("hand-after-cancelled-runout");
    expect(serverProjection().version).toBe(version);
  });
});
