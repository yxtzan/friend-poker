import { afterEach, describe, expect, it } from "vitest";

import { RuntimeCommandType, TransportEvent } from "../src/index.js";
import {
  ClientSitInitialGrantRegistry,
  clientSitInitialGrantLedgerEntryId,
} from "../src/transport/initial-grant.js";
import type { TransportFixture } from "./transport-helpers.js";
import {
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

async function startedPair() {
  fixture = await createTransportFixture();
  const alice = await createConnectedClient(fixture, "Alice", { kind: "SEAT", seat: 0 });
  const bob = await createConnectedClient(fixture, "Bob", { kind: "SEAT", seat: 1 });
  await synchronizeClients([alice, bob]);
  const start = await executeSocketCommand(
    alice.socket,
    nextCommand(alice.latestProjection, "start-session", {
      type: RuntimeCommandType.StartSession,
      sessionId: "session-transport",
      initialGrants: [
        { playerId: alice.identity.playerId, ledgerEntryId: "initial-alice" },
        { playerId: bob.identity.playerId, ledgerEntryId: "initial-bob" },
      ],
    }),
  );
  expect(start.status).toBe("APPLIED");
  await Promise.all(
    [alice, bob].map((client) =>
      client.latestProjection.version === start.version
        ? Promise.resolve(client.latestProjection)
        : waitForProjection(client.socket, (projection) => projection.version === start.version),
    ),
  );
  return { alice, bob };
}

describe("bound identity and malicious socket payloads", () => {
  it("ignores a mutation event that omits the required acknowledgement callback", async () => {
    const { bob } = await startedPair();
    const version = bob.latestProjection.version;
    const maliciousSocket = bob.socket as unknown as {
      emit(event: string, payload: unknown): void;
    };
    maliciousSocket.emit(TransportEvent.TableCommand, {
      commandId: "missing-ack",
      expectedVersion: version,
      command: { type: RuntimeCommandType.Replenish, ledgerEntryId: "missing-ack-ledger" },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(bob.latestProjection.version).toBe(version);
    expect(findPublicPlayer(bob.latestProjection, bob.identity.playerId)?.chipBalance).toBe(100);
  });

  it("ignores actor/player/principal spoofing and never grants SYSTEM authority", async () => {
    const { alice, bob } = await startedPair();
    const before = bob.latestProjection;
    const spoofed = await executeSocketCommand(bob.socket, {
      commandId: "spoof-replenish",
      expectedVersion: before.version,
      actorId: alice.identity.playerId,
      playerId: alice.identity.playerId,
      principal: { kind: "SYSTEM", systemId: "attacker" },
      command: {
        type: RuntimeCommandType.Replenish,
        playerId: alice.identity.playerId,
        ledgerEntryId: "spoof-ledger",
      },
    });

    expect(spoofed.status).toBe("APPLIED");
    expect(findPublicPlayer(spoofed.projection, alice.identity.playerId)?.chipBalance).toBe(100);
    expect(findPublicPlayer(spoofed.projection, bob.identity.playerId)?.chipBalance).toBe(200);

    const systemSpoof = await executeSocketCommand(bob.socket, {
      commandId: "spoof-system",
      expectedVersion: spoofed.version,
      principal: { kind: "SYSTEM" },
      command: {
        type: RuntimeCommandType.SetOnline,
        targetPlayerId: alice.identity.playerId,
        online: false,
      },
    });
    expect(systemSpoof).toMatchObject({
      status: "REJECTED",
      reason: "UNAUTHORIZED_IDENTITY",
    });
  });

  it("rejects non-host, stale, malformed, unknown, and nickname-edit commands safely", async () => {
    const { bob } = await startedPair();
    const version = bob.latestProjection.version;
    const nonHost = await executeSocketCommand(bob.socket, {
      commandId: "non-host",
      expectedVersion: version,
      command: { type: RuntimeCommandType.ChangeBlinds, smallBlind: 2, bigBlind: 4 },
    });
    const stale = await executeSocketCommand(bob.socket, {
      commandId: "stale",
      expectedVersion: version - 1,
      command: { type: RuntimeCommandType.Replenish, ledgerEntryId: "stale-ledger" },
    });
    const malformed = await executeSocketCommand(bob.socket, null);
    const unknown = await executeSocketCommand(bob.socket, {
      commandId: "unknown",
      expectedVersion: version,
      command: { type: "BECOME_SYSTEM" },
    });
    const rename = await executeSocketCommand(bob.socket, {
      commandId: "rename",
      expectedVersion: version,
      command: {
        type: RuntimeCommandType.EnterTable,
        nickname: "NewBob",
        position: { kind: "SEAT", seat: 1 },
      },
    });

    expect(nonHost).toMatchObject({ status: "REJECTED", reason: "UNAUTHORIZED_IDENTITY" });
    expect(stale).toMatchObject({ status: "REJECTED", reason: "STALE_VERSION" });
    expect(malformed).toMatchObject({ status: "REJECTED", reason: "INVALID_COMMAND" });
    expect(unknown).toMatchObject({ status: "REJECTED", reason: "INVALID_COMMAND" });
    expect(rename).toMatchObject({ status: "REJECTED", reason: "INVALID_COMMAND" });
    expect(rename).not.toHaveProperty("stack");
    expect(JSON.stringify(rename)).not.toMatch(/credential|cookie|tokenHash/iu);
  });
});

describe("transport acknowledgement and broadcast policy", () => {
  it("broadcasts APPLIED once and does not globally broadcast NO_OP, DUPLICATE, or REJECTED", async () => {
    const { alice, bob } = await startedPair();
    let bobBroadcasts = 0;
    bob.socket.on("TABLE_STATE", () => {
      bobBroadcasts += 1;
    });
    const appliedInput = nextCommand(alice.latestProjection, "adjust-once", {
      type: RuntimeCommandType.HostAdjustChips,
      targetPlayerId: bob.identity.playerId,
      amount: 1,
      ledgerEntryId: "adjust-once-ledger",
    });
    const appliedProjection = waitForProjection(
      bob.socket,
      (projection) => projection.version === appliedInput.expectedVersion + 1,
    );
    const applied = await executeSocketCommand(alice.socket, appliedInput);
    await appliedProjection;
    const broadcastsAfterApplied = bobBroadcasts;

    const duplicate = await executeSocketCommand(alice.socket, appliedInput);
    const noOp = await executeSocketCommand(
      bob.socket,
      nextCommand(bob.latestProjection, "sit-no-op", {
        type: RuntimeCommandType.Sit,
        seat: 1,
      }),
    );
    const rejected = await executeSocketCommand(bob.socket, {
      commandId: "stale-no-broadcast",
      expectedVersion: bob.latestProjection.version - 1,
      command: { type: RuntimeCommandType.Replenish, ledgerEntryId: "never" },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(applied.status).toBe("APPLIED");
    expect(broadcastsAfterApplied).toBe(1);
    expect(duplicate.status).toBe("DUPLICATE");
    expect(noOp.status).toBe("NO_OP");
    expect(rejected.status).toBe("REJECTED");
    expect(bobBroadcasts).toBe(broadcastsAfterApplied);
  });
});

describe("client SIT initial-grant IDs", () => {
  it("derives a stable namespaced ID from the authenticated player and command", () => {
    const original = clientSitInitialGrantLedgerEntryId("player-a", "sit-123");

    expect(clientSitInitialGrantLedgerEntryId("player-a", "sit-123")).toBe(original);
    expect(clientSitInitialGrantLedgerEntryId("player-b", "sit-123")).not.toBe(original);
    expect(clientSitInitialGrantLedgerEntryId("player-a", "sit-456")).not.toBe(original);
    expect(original).toMatch(/^transport-sit-initial-grant-[a-f0-9]{64}$/u);
  });

  it("retains the original state-dependent enrichment by principal and command ID", () => {
    const registry = new ClientSitInitialGrantRegistry();

    expect(registry.resolve("player-a", "sit-123", true)).toBe(true);
    expect(registry.resolve("player-a", "sit-123", false)).toBe(true);
    expect(registry.resolve("player-a", "sit-456", false)).toBe(false);
    expect(registry.resolve("player-b", "sit-123", false)).toBe(false);
  });
});

describe("SIT transport idempotency", () => {
  it("replays a first-Session spectator SIT as DUPLICATE without granting chips twice", async () => {
    await startedPair();
    const spectator = await createConnectedClient(fixture!, "Watcher", {
      kind: "SPECTATOR",
    });
    const input = nextCommand(spectator.latestProjection, "spectator-sit-once", {
      type: RuntimeCommandType.Sit,
      seat: 2,
    });

    const first = await executeSocketCommand(spectator.socket, input);
    const versionAfterFirst = first.version;
    const firstGrantEntries = first.projection.session?.ledger.filter(
      (entry) =>
        entry.playerId === spectator.identity.playerId && entry.type === "INITIAL_GRANT",
    );

    expect(first.status).toBe("APPLIED");
    expect(findPublicPlayer(first.projection, spectator.identity.playerId)).toMatchObject({
      seat: 2,
      chipBalance: 100,
    });
    expect(firstGrantEntries).toEqual([
      expect.objectContaining({
        ledgerEntryId: clientSitInitialGrantLedgerEntryId(
          spectator.identity.playerId,
          input.commandId,
        ),
      }),
    ]);

    const duplicate = await executeSocketCommand(spectator.socket, input);
    const duplicateGrantEntries = duplicate.projection.session?.ledger.filter(
      (entry) =>
        entry.playerId === spectator.identity.playerId && entry.type === "INITIAL_GRANT",
    );

    expect(duplicate).toMatchObject({
      status: "DUPLICATE",
      commandId: input.commandId,
      version: versionAfterFirst,
      originalStatus: "APPLIED",
      originalVersion: versionAfterFirst,
    });
    expect(findPublicPlayer(duplicate.projection, spectator.identity.playerId)?.chipBalance).toBe(
      100,
    );
    expect(duplicateGrantEntries).toHaveLength(1);
    expect(fixture!.server.runtime.version).toBe(versionAfterFirst);

    const collision = await executeSocketCommand(spectator.socket, {
      ...input,
      command: { type: RuntimeCommandType.Sit, seat: 3 },
    });

    expect(collision).toMatchObject({
      status: "REJECTED",
      commandId: input.commandId,
      version: versionAfterFirst,
      reason: "INVALID_COMMAND",
    });
    expect(fixture!.server.runtime.version).toBe(versionAfterFirst);
    expect(findPublicPlayer(collision.projection, spectator.identity.playerId)).toMatchObject({
      seat: 2,
      chipBalance: 100,
    });
    expect(
      collision.projection.session?.ledger.filter(
        (entry) =>
          entry.playerId === spectator.identity.playerId && entry.type === "INITIAL_GRANT",
      ),
    ).toHaveLength(1);
  });
});
