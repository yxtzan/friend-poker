import { afterEach, describe, expect, it } from "vitest";

import type { Card } from "@friend-poker/poker-engine";
import {
  RuntimeCommandType,
  TransportEvent,
} from "../src/index.js";
import type { SafeTableProjection } from "../src/index.js";
import type { TransportFixture } from "./transport-helpers.js";
import {
  connectWithCookie,
  createConnectedClient,
  createTransportFixture,
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

function cardTokens(cards: readonly Card[]): readonly string[] {
  return cards.map((card) => JSON.stringify(card));
}

function expectNoForbiddenTransportState(
  projection: SafeTableProjection,
  credentials: readonly string[],
): void {
  const serialized = JSON.stringify(projection);
  expect(serialized).not.toMatch(
    /remainingDeck|privateHoleCards|activeHand|bettingState|credential|cookie|tokenHash|secret/iu,
  );
  for (const credential of credentials) expect(serialized).not.toContain(credential);
}

async function createStartedClients() {
  fixture = await createTransportFixture();
  const alice = await createConnectedClient(fixture, "Alice", { kind: "SEAT", seat: 0 });
  const bob = await createConnectedClient(fixture, "Bob", { kind: "SEAT", seat: 1 });
  const carol = await createConnectedClient(fixture, "小明3", { kind: "SEAT", seat: 2 });
  const spectator = await createConnectedClient(fixture, "Watcher", { kind: "SPECTATOR" });
  const clients = [alice, bob, carol, spectator] as const;
  await synchronizeClients(clients);
  const start = await executeSocketCommand(
    alice.socket,
    nextCommand(alice.latestProjection, "start-private-session", {
      type: RuntimeCommandType.StartSession,
      sessionId: "socket-private-session",
      initialGrants: [alice, bob, carol].map((client) => ({
        playerId: client.identity.playerId,
        ledgerEntryId: `initial-${client.identity.playerId}`,
      })),
    }),
  );
  expect(start.status).toBe("APPLIED");
  const startHand = await executeSocketCommand(
    alice.socket,
    nextCommand(alice.latestProjection, "start-private-hand", {
      type: RuntimeCommandType.StartFirstHand,
      handId: "socket-private-hand",
      buttonSeat: 0,
    }),
  );
  expect(startHand.status).toBe("APPLIED");
  expectNoForbiddenTransportState(startHand.projection, fixture.issuedCredentials);
  await Promise.all(
    clients.map((client) =>
      client.latestProjection.version === startHand.version
        ? Promise.resolve(client.latestProjection)
        : waitForProjection(client.socket, (projection) => projection.version === startHand.version),
    ),
  );
  return { alice, bob, carol, spectator };
}

describe("private projections over real Socket.IO payloads", () => {
  it("sends each player only their own cards and sends spectators none", async () => {
    const { alice, bob, carol, spectator } = await createStartedClients();
    const players = [alice, bob, carol] as const;
    const cards = new Map(
      players.map((client) => [client.identity.playerId, client.latestProjection.ownHoleCards!]),
    );

    for (const client of players) {
      const ownCards = cards.get(client.identity.playerId)!;
      const serialized = JSON.stringify(client.latestProjection);
      for (const token of cardTokens(ownCards)) expect(serialized).toContain(token);
      for (const other of players.filter((candidate) => candidate !== client)) {
        for (const token of cardTokens(cards.get(other.identity.playerId)!)) {
          expect(serialized).not.toContain(token);
        }
      }
      expectNoForbiddenTransportState(client.latestProjection, fixture!.issuedCredentials);
    }
    expect(spectator.latestProjection.ownHoleCards).toBeNull();
    for (const hiddenCards of cards.values()) {
      for (const token of cardTokens(hiddenCards)) {
        expect(JSON.stringify(spectator.latestProjection)).not.toContain(token);
      }
    }
    expectNoForbiddenTransportState(spectator.latestProjection, fixture!.issuedCredentials);
  });
});

describe("disconnect, reconnect, and kick lifecycle", () => {
  it("keeps explicit leave distinct from disconnect and permits controlled credential re-entry", async () => {
    fixture = await createTransportFixture();
    const client = await createConnectedClient(fixture, "Leaver", { kind: "SEAT", seat: 0 });
    const left = await executeSocketCommand(
      client.socket,
      nextCommand(client.latestProjection, "explicit-leave", {
        type: RuntimeCommandType.LeaveTable,
      }),
    );
    expect(left.status).toBe("APPLIED");
    await waitForDisconnect(client.socket);
    expect(client.socket.connected).toBe(false);
    expect(findPublicPlayer(left.projection, client.identity.playerId)).toBeUndefined();

    const reentered = await enterIdentity(
      fixture,
      "IgnoredRename",
      { kind: "SPECTATOR" },
      { cookie: client.cookie },
    );
    expect(reentered).toMatchObject({
      status: 200,
      body: {
        status: "RESTORED",
        playerId: client.identity.playerId,
        nickname: "Leaver",
      },
    });
  });

  it("marks disconnect offline and restores the same in-hand identity, cards, seat, and chips", async () => {
    const { alice, bob } = await createStartedClients();
    const playerId = alice.identity.playerId;
    const before = alice.latestProjection;
    const ownCards = before.ownHoleCards;
    const chipBalance = findPublicPlayer(before, playerId)!.chipBalance;
    const offlineProjection = waitForProjection(
      bob.socket,
      (projection) => findPublicPlayer(projection, playerId)?.online === false,
    );
    alice.socket.disconnect();
    const offline = await offlineProjection;

    expect(findPublicPlayer(offline, playerId)).toMatchObject({
      seat: 0,
      online: false,
      chipBalance,
    });
    const reconnected = await connectWithCookie(fixture!, alice.cookie);
    const restored = reconnected.initialProjection;
    expect(findPublicPlayer(restored, playerId)).toMatchObject({
      seat: 0,
      online: true,
      chipBalance,
    });
    expect(restored.ownHoleCards).toEqual(ownCards);
    expect(
      restored.session?.ledger.filter(
        (entry) => entry.playerId === playerId && entry.type === "INITIAL_GRANT",
      ),
    ).toHaveLength(1);
  });

  it("revokes a kicked credential, disconnects its socket, and re-enters with no second grant", async () => {
    fixture = await createTransportFixture();
    const host = await createConnectedClient(fixture, "Host", { kind: "SEAT", seat: 0 });
    const target = await createConnectedClient(fixture, "Returner", { kind: "SEAT", seat: 1 });
    await synchronizeClients([host, target]);
    await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "kick-session", {
        type: RuntimeCommandType.StartSession,
        sessionId: "kick-session",
        initialGrants: [host, target].map((client) => ({
          playerId: client.identity.playerId,
          ledgerEntryId: `kick-initial-${client.identity.playerId}`,
        })),
      }),
    );
    const disconnectPromise = waitForDisconnect(target.socket);
    const revokedPromise = new Promise<void>((resolve) =>
      target.socket.once(TransportEvent.IdentityRevoked, () => resolve()),
    );
    const kicked = await executeSocketCommand(
      host.socket,
      nextCommand(host.latestProjection, "kick-target", {
        type: RuntimeCommandType.Kick,
        targetPlayerId: target.identity.playerId,
      }),
    );
    await Promise.all([disconnectPromise, revokedPromise]);

    expect(kicked.status).toBe("APPLIED");
    expect(await expectConnectionError(fixture, target.cookie)).toBe("AUTH_REQUIRED");
    const unsafeReentry = await enterIdentity(fixture, "Returner", { kind: "SEAT", seat: 1 });
    expect(unsafeReentry).toMatchObject({
      status: 409,
      body: { error: "NICKNAME_UNAVAILABLE" },
    });
    const reentered = await enterIdentity(
      fixture,
      "Returner",
      { kind: "SEAT", seat: 1 },
      { reenterAfterKick: true },
    );
    expect(reentered.status).toBe(200);
    expect((reentered.body as { playerId: string }).playerId).toBe(target.identity.playerId);
    expect(reentered.cookie).not.toBe(target.cookie);
    const restored = await connectWithCookie(fixture, reentered.cookie!);
    expect(findPublicPlayer(restored.initialProjection, target.identity.playerId)?.chipBalance).toBe(
      100,
    );
    expect(
      restored.initialProjection.session?.ledger.filter(
        (entry) =>
          entry.playerId === target.identity.playerId && entry.type === "INITIAL_GRANT",
      ),
    ).toHaveLength(1);
  });
});
