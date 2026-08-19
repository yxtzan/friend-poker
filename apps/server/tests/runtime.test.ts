import { describe, expect, it } from "vitest";

import { PlayerActionType } from "@friend-poker/poker-engine";
import {
  CommandRejectionReason,
  RuntimeCommandType,
} from "../src/index.js";
import type { CommandEnvelope } from "../src/index.js";
import {
  playerPrincipal,
  seatedRuntime,
  startFirstHand,
  startedRuntime,
} from "./helpers.js";

describe("authoritative runtime versions and rejections", () => {
  it("increments version exactly once for a successful mutation", async () => {
    const fixture = await seatedRuntime(["A"]);
    const before = fixture.runtime.version;
    const result = await fixture.clients.A!.execute({
      type: RuntimeCommandType.StandToSpectate,
    });

    expect(result).toMatchObject({ status: "APPLIED", version: before + 1 });
    expect(fixture.runtime.version).toBe(before + 1);
  });

  it("leaves version and state unchanged after a domain rejection", async () => {
    const fixture = await startedRuntime(["A", "B"]);
    await startFirstHand(fixture);
    const beforeVersion = fixture.runtime.version;
    const beforeProjection = fixture.system.projection();
    const result = await fixture.clients.B!.execute({
      type: RuntimeCommandType.StandToSpectate,
    });

    expect(result).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.DomainRule,
      version: beforeVersion,
    });
    expect(result).not.toHaveProperty("stack");
    expect(fixture.runtime.version).toBe(beforeVersion);
    expect(fixture.system.projection()).toEqual(beforeProjection);
  });

  it("returns a typed rejection for a malformed envelope", async () => {
    const fixture = await startedRuntime();
    const version = fixture.runtime.version;
    const result = await fixture.runtime.execute(
      playerPrincipal("A"),
      null as unknown as CommandEnvelope,
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      commandId: "INVALID_COMMAND",
      reason: CommandRejectionReason.InvalidCommand,
      version,
    });
    expect(fixture.runtime.version).toBe(version);
  });

  it("does not increment for a referential or structural no-op", async () => {
    const fixture = await startedRuntime();
    const before = fixture.runtime.version;
    const envelope = fixture.clients.B!.envelope({
      type: RuntimeCommandType.Sit,
      seat: 1,
    });
    const first = await fixture.clients.B!.replay(envelope);
    const duplicate = await fixture.clients.B!.replay(envelope);

    expect(first).toMatchObject({ status: "NO_OP", version: before });
    expect(duplicate).toMatchObject({
      status: "DUPLICATE",
      originalStatus: "NO_OP",
      originalVersion: before,
      version: before,
    });
  });

  it("rejects stale seat changes with a fresh versioned projection", async () => {
    const fixture = await startedRuntime();
    const staleVersion = fixture.runtime.version;
    await fixture.clients.A!.execute({
      type: RuntimeCommandType.ChangeBlinds,
      smallBlind: 2,
      bigBlind: 4,
    });
    const result = await fixture.clients.B!.execute(
      { type: RuntimeCommandType.Sit, seat: 2 },
      { expectedVersion: staleVersion },
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.StaleVersion,
      version: staleVersion + 1,
      projection: { version: staleVersion + 1 },
    });
    expect(result.projection.seats[1]?.playerId).toBe("B");
    expect(result.projection.seats[2]).toBeNull();
  });
});

describe("command idempotency", () => {
  it("applies a duplicate replenish command exactly once", async () => {
    const fixture = await startedRuntime();
    const envelope = fixture.clients.A!.envelope({
      type: RuntimeCommandType.Replenish,
      ledgerEntryId: "replenish-a",
    });
    const first = await fixture.clients.A!.replay(envelope);
    const versionAfterFirst = fixture.runtime.version;
    const second = await fixture.clients.A!.replay(envelope);
    const third = await fixture.clients.A!.replay(envelope);

    expect(first.status).toBe("APPLIED");
    expect(second).toMatchObject({
      status: "DUPLICATE",
      originalVersion: versionAfterFirst,
    });
    expect(third).toEqual(second);
    expect(fixture.runtime.version).toBe(versionAfterFirst);
    expect(
      fixture.system
        .projection()
        .session?.ledger.filter((entry) => entry.ledgerEntryId === "replenish-a"),
    ).toHaveLength(1);
    expect(fixture.system.projection().seats[0]?.chipBalance).toBe(200);
  });

  it("applies a duplicate host adjustment exactly once", async () => {
    const fixture = await startedRuntime();
    const envelope = fixture.clients.A!.envelope({
      type: RuntimeCommandType.HostAdjustChips,
      targetPlayerId: "B",
      amount: 25,
      ledgerEntryId: "host-plus-25",
    });
    await fixture.clients.A!.replay(envelope);
    const version = fixture.runtime.version;
    const duplicate = await fixture.clients.A!.replay(envelope);

    expect(duplicate.status).toBe("DUPLICATE");
    expect(fixture.runtime.version).toBe(version);
    expect(fixture.system.projection().seats[1]?.chipBalance).toBe(125);
    expect(
      fixture.system
        .projection()
        .session?.ledger.filter((entry) => entry.ledgerEntryId === "host-plus-25"),
    ).toHaveLength(1);
  });

  it("executes a duplicate poker action only once", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await startFirstHand(fixture);
    const actorId = fixture.system.projection().currentHand!.currentActorId!;
    const actor = fixture.clients[actorId]!;
    const envelope = actor.envelope({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Fold },
    });
    await actor.replay(envelope);
    const version = fixture.runtime.version;
    const duplicate = await actor.replay(envelope);

    expect(duplicate.status).toBe("DUPLICATE");
    expect(fixture.runtime.version).toBe(version);
    expect(
      fixture.system.projection().currentHand?.actions.filter((action) => action.playerId === actorId),
    ).toHaveLength(1);
  });

  it("rejects command ID reuse with a different payload", async () => {
    const fixture = await startedRuntime();
    await fixture.clients.A!.execute(
      { type: RuntimeCommandType.Replenish, ledgerEntryId: "r1" },
      { commandId: "collision" },
    );
    const result = await fixture.clients.A!.execute(
      { type: RuntimeCommandType.Replenish, ledgerEntryId: "r2" },
      { commandId: "collision" },
    );
    expect(result).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.InvalidCommand,
    });
  });
});

describe("identity and host authority", () => {
  it("does not allow a bound player to submit another player's actor identity", async () => {
    const fixture = await startedRuntime();
    const forged = fixture.clients.A!.envelope({
      type: RuntimeCommandType.Replenish,
      ledgerEntryId: "forged",
    });
    const result = await fixture.runtime.execute(playerPrincipal("B"), forged);

    expect(result).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.UnauthorizedIdentity,
    });
    expect(fixture.system.projection().session?.ledger).toHaveLength(2);
  });

  it("rejects non-host host commands before the domain call", async () => {
    const fixture = await startedRuntime();
    const result = await fixture.clients.B!.execute({
      type: RuntimeCommandType.ChangeBlinds,
      smallBlind: 2,
      bigBlind: 4,
    });
    expect(result).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.UnauthorizedIdentity,
    });
    expect(fixture.system.projection().session?.blinds).toEqual({
      smallBlind: 1,
      bigBlind: 2,
    });
  });

  it("derives host authority from current table state after transfer", async () => {
    const fixture = await startedRuntime();
    await fixture.clients.A!.execute({
      type: RuntimeCommandType.TransferHost,
      targetPlayerId: "B",
    });
    const oldHost = await fixture.clients.A!.execute({
      type: RuntimeCommandType.ChangeBlinds,
      smallBlind: 2,
      bigBlind: 4,
    });
    const newHost = await fixture.clients.B!.execute({
      type: RuntimeCommandType.ChangeBlinds,
      smallBlind: 2,
      bigBlind: 4,
    });

    expect(oldHost).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.UnauthorizedIdentity,
    });
    expect(newHost.status).toBe("APPLIED");
    expect(fixture.system.projection().hostPlayerId).toBe("B");
  });

  it("allows internal online/runout commands only through a system principal", async () => {
    const fixture = await startedRuntime();
    const playerAttempt = await fixture.clients.A!.execute({
      type: RuntimeCommandType.SetOnline,
      targetPlayerId: "B",
      online: false,
    });
    const systemResult = await fixture.system.execute({
      type: RuntimeCommandType.SetOnline,
      targetPlayerId: "B",
      online: false,
    });
    expect(playerAttempt).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.UnauthorizedIdentity,
    });
    expect(systemResult.status).toBe("APPLIED");
    expect(fixture.system.projection().seats[1]?.online).toBe(false);
  });
});

describe("serialized execution and read behavior", () => {
  it("serializes concurrent commands from the same version", async () => {
    const fixture = await startedRuntime();
    const version = fixture.runtime.version;
    const commandA = fixture.clients.A!.envelope(
      { type: RuntimeCommandType.Replenish, ledgerEntryId: "concurrent-a" },
      { expectedVersion: version },
    );
    const commandB = fixture.clients.B!.envelope(
      { type: RuntimeCommandType.Replenish, ledgerEntryId: "concurrent-b" },
      { expectedVersion: version },
    );
    const [resultA, resultB] = await Promise.all([
      fixture.clients.A!.replay(commandA),
      fixture.clients.B!.replay(commandB),
    ]);

    expect(resultA.status).toBe("APPLIED");
    expect(resultB).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.StaleVersion,
    });
    expect(fixture.runtime.version).toBe(version + 1);
    expect(fixture.system.projection().session?.ledger).toHaveLength(3);
  });

  it("rejects a second client poker action based on the same stale version", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await startFirstHand(fixture);
    const version = fixture.runtime.version;
    const actorId = fixture.system.projection().currentHand!.currentActorId!;
    const actor = fixture.clients[actorId]!;
    const first = actor.envelope(
      {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.Fold },
      },
      { expectedVersion: version },
    );
    const stale = actor.envelope(
      {
        type: RuntimeCommandType.PokerAction,
        action: { type: PlayerActionType.Fold },
      },
      { expectedVersion: version },
    );
    const firstResult = await actor.replay(first);
    const staleResult = await actor.replay(stale);

    expect(firstResult.status).toBe("APPLIED");
    expect(staleResult).toMatchObject({
      status: "REJECTED",
      reason: CommandRejectionReason.StaleVersion,
    });
    expect(fixture.system.projection().currentHand?.actions).toHaveLength(1);
  });

  it("does not mutate or increment version for projections or end previews", async () => {
    const fixture = await startedRuntime();
    const version = fixture.runtime.version;
    const firstProjection = fixture.runtime.getProjection({ kind: "PLAYER", playerId: "A" });
    const secondProjection = fixture.runtime.getProjection({ kind: "PLAYER", playerId: "A" });
    const preview = await fixture.clients.A!.execute({
      type: RuntimeCommandType.PrepareEndSession,
    });

    expect(firstProjection).toEqual(secondProjection);
    expect(fixture.runtime.version).toBe(version);
    expect(preview).toMatchObject({
      status: "NO_OP",
      version,
      data: { kind: "SESSION_END_PREVIEW" },
    });
  });

  it("ends a Session through the authoritative preview/confirmation path", async () => {
    const fixture = await startedRuntime();
    const previewResult = await fixture.clients.A!.execute({
      type: RuntimeCommandType.PrepareEndSession,
    });
    if (
      previewResult.status === "REJECTED" ||
      previewResult.status === "DUPLICATE" ||
      previewResult.data.kind !== "SESSION_END_PREVIEW"
    ) {
      throw new Error("Expected a Session end preview");
    }
    const version = fixture.runtime.version;
    const endResult = await fixture.clients.A!.execute({
      type: RuntimeCommandType.EndSession,
      confirmation: previewResult.data.preview,
    });

    expect(endResult).toMatchObject({ status: "APPLIED", version: version + 1 });
    expect(fixture.system.projection()).toMatchObject({
      version: version + 1,
      status: "SESSION_ENDED",
      session: { sessionId: "session-1", completedHandCount: 0 },
    });
    expect(fixture.system.projection().recentSessions).toHaveLength(1);
  });
});
