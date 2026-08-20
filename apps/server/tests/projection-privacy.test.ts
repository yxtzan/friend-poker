import { describe, expect, it } from "vitest";

import {
  HandLifecycleStatus,
  PlayerActionType,
} from "@friend-poker/poker-engine";
import {
  RuntimeCommandType,
  SingleTableRuntime,
} from "../src/index.js";
import type { Card, PlayerId } from "@friend-poker/poker-engine";
import type { SafeTableProjection } from "../src/index.js";
import {
  completeWithCallsAndChecks,
  playerPrincipal,
  SimulatedClient,
  startFirstHand,
  startedRuntime,
} from "./helpers.js";

function cardTokens(cards: readonly Card[]): readonly string[] {
  return cards.map((card) => JSON.stringify(card));
}

function expectNoRawStateKeys(projection: SafeTableProjection): void {
  const serialized = JSON.stringify(projection);
  expect(serialized).not.toContain("remainingDeck");
  expect(serialized).not.toContain("privateHoleCards");
  expect(serialized).not.toContain("activeHand");
  expect(serialized).not.toContain("bettingState");
  expect(serialized).not.toContain("uncontestedRevealOpportunity");
  expect(serialized).not.toMatch(/credential|secret|tokenHash|identityToken/iu);
}

function expectContainsCards(
  projection: SafeTableProjection,
  cards: readonly Card[],
): void {
  const serialized = JSON.stringify(projection);
  for (const token of cardTokens(cards)) expect(serialized).toContain(token);
}

function expectExcludesCards(
  projection: SafeTableProjection,
  cards: readonly Card[],
): void {
  const serialized = JSON.stringify(projection);
  for (const token of cardTokens(cards)) expect(serialized).not.toContain(token);
}

function captureOwnCards(
  fixture: Awaited<ReturnType<typeof startedRuntime>>,
  playerIds: readonly PlayerId[],
): Readonly<Record<PlayerId, readonly [Card, Card]>> {
  return Object.freeze(
    Object.fromEntries(
      playerIds.map((playerId) => {
        const cards = fixture.clients[playerId]!.projection().ownHoleCards;
        if (cards === null) throw new Error(`Missing private cards for ${playerId}`);
        return [playerId, cards];
      }),
    ),
  );
}

describe("per-viewer private-card projection", () => {
  it.each([2, 6])("shows only each participant's own cards in a %i-player hand", async (count) => {
    const playerIds = ["A", "B", "C", "D", "E", "F"].slice(0, count);
    const fixture = await startedRuntime(playerIds);
    await startFirstHand(fixture);
    const cards = captureOwnCards(fixture, playerIds);

    for (const viewerId of playerIds) {
      const projection = fixture.clients[viewerId]!.projection();
      expectContainsCards(projection, cards[viewerId]!);
      for (const otherId of playerIds.filter((playerId) => playerId !== viewerId)) {
        expectExcludesCards(projection, cards[otherId]!);
      }
      expectNoRawStateKeys(projection);
    }

    const spectator = fixture.runtime.getProjection({ kind: "SPECTATOR" });
    for (const playerId of playerIds) expectExcludesCards(spectator, cards[playerId]!);
    expectNoRawStateKeys(spectator);
  });

  it("gives an actual spectator no private cards", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    const spectator = new SimulatedClient(fixture.runtime, playerPrincipal("S"));
    await spectator.execute({
      type: RuntimeCommandType.EnterTable,
      nickname: "Spectator",
      position: { kind: "SPECTATOR" },
    });
    await startFirstHand(fixture);
    const cards = captureOwnCards(fixture, ["A", "B", "C"]);
    const projection = spectator.projection();

    expect(projection.ownHoleCards).toBeNull();
    for (const hand of Object.values(cards)) expectExcludesCards(projection, hand);
    expect(projection.spectators.map(({ playerId }) => playerId)).toContain("S");
  });

  it("omits arbitrary domain metadata from public ledgers and Session summaries", async () => {
    const fixture = await startedRuntime();
    await fixture.clients.A!.execute({
      type: RuntimeCommandType.HostAdjustChips,
      targetPlayerId: "B",
      amount: 1,
      ledgerEntryId: "metadata-adjustment",
      metadata: {
        identityToken: "private-identity-value",
        secret: "private-secret-value",
      },
    });
    const activeProjection = JSON.stringify(fixture.system.projection());
    expect(activeProjection).not.toMatch(/identityToken|private-identity-value|secret/iu);

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
    await fixture.clients.A!.execute({
      type: RuntimeCommandType.EndSession,
      confirmation: previewResult.data.preview,
      endMetadata: { tokenHash: "private-hash-value" },
    });
    const endedProjection = fixture.system.projection();
    expect(JSON.stringify(endedProjection)).not.toMatch(/tokenHash|private-hash-value/iu);
    expectNoRawStateKeys(endedProjection);
  });

  it("gives a seated but offline non-participant no cards", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await fixture.system.execute({
      type: RuntimeCommandType.SetOnline,
      targetPlayerId: "C",
      online: false,
    });
    await startFirstHand(fixture);

    expect(fixture.clients.C!.projection().ownHoleCards).toBeNull();
    expect(
      fixture.system.projection().currentHand?.participants.map(({ playerId }) => playerId),
    ).toEqual(["A", "B"]);
  });

  it("projects legal actions only to the current player", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await startFirstHand(fixture);
    const hand = fixture.system.projection().currentHand!;
    const actorId = hand.currentActorId!;
    const otherId = ["A", "B", "C"].find((playerId) => playerId !== actorId)!;

    const actorActions = fixture.clients[actorId]!.projection().viewerLegalActions;
    expect(actorActions).not.toBeNull();
    expect(actorActions).toMatchObject({
      playerId: actorId,
      canFold: true,
      callAmount: expect.any(Number),
      allInTo: expect.any(Number),
    });
    expect(fixture.clients[otherId]!.projection().viewerLegalActions).toBeNull();
    expect(fixture.runtime.getProjection({ kind: "SPECTATOR" }).viewerLegalActions).toBeNull();

    await fixture.clients[actorId]!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Fold },
    });
    expect(fixture.clients[actorId]!.projection().viewerLegalActions).toBeNull();
    expect(JSON.stringify(actorActions)).not.toMatch(/remainingDeck|privateHoleCards|bettingState/iu);
  });

  it("projects uncontested reveal only to the hand winner", async () => {
    const fixture = await startedRuntime(["A", "B"]);
    await startFirstHand(fixture);
    const actorId = fixture.system.projection().currentHand!.currentActorId!;
    const winnerId = actorId === "A" ? "B" : "A";

    await fixture.clients[actorId]!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Fold },
    });

    expect(fixture.clients[winnerId]!.projection().viewerCanRevealUncontested).toBe(true);
    expect(fixture.clients[actorId]!.projection().viewerCanRevealUncontested).toBe(false);
    expect(fixture.runtime.getProjection({ kind: "SPECTATOR" }).viewerCanRevealUncontested).toBe(false);
  });

  it("lets a folded player retain only their own cards until the hand completes", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await startFirstHand(fixture);
    const cards = captureOwnCards(fixture, ["A", "B", "C"]);
    const actorId = fixture.system.projection().currentHand!.currentActorId!;
    await fixture.clients[actorId]!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Fold },
    });

    expect(fixture.system.projection().currentHand).not.toBeNull();
    expectContainsCards(fixture.clients[actorId]!.projection(), cards[actorId]!);
    for (const otherId of ["A", "B", "C"].filter((id) => id !== actorId)) {
      expectExcludesCards(fixture.clients[otherId]!.projection(), cards[actorId]!);
    }

    await completeWithCallsAndChecks(fixture);
    const history = fixture.system.projection().recentHands.at(-1)!;
    expectExcludesCards(
      { ...fixture.system.projection(), recentHands: [history] },
      cards[actorId]!,
    );
  });
});

describe("revealed-card and history boundaries", () => {
  it("publishes legitimately revealed non-folded cards after normal Showdown", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await startFirstHand(fixture, "showdown");
    const cards = captureOwnCards(fixture, ["A", "B", "C"]);
    await completeWithCallsAndChecks(fixture);
    const publicProjection = fixture.system.projection();

    expect(publicProjection.currentHand).toBeNull();
    expect(publicProjection.recentHands.at(-1)?.record.revealedHoleCards).toHaveLength(3);
    for (const hand of Object.values(cards)) expectContainsCards(publicProjection, hand);
    expectNoRawStateKeys(publicProjection);
  });

  it("keeps an uncontested hand hidden until its winner voluntarily reveals", async () => {
    const fixture = await startedRuntime(["A", "B"]);
    await startFirstHand(fixture, "uncontested");
    const cards = captureOwnCards(fixture, ["A", "B"]);
    const foldingId = fixture.system.projection().currentHand!.currentActorId!;
    await fixture.clients[foldingId]!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Fold },
    });
    const winnerId = foldingId === "A" ? "B" : "A";
    const hiddenProjection = fixture.system.projection();

    expect(hiddenProjection.recentHands.at(-1)?.record.revealedHoleCards).toEqual([]);
    expect(fixture.clients[winnerId]!.projection().viewerCanRevealUncontested).toBe(true);
    expect(fixture.clients[foldingId]!.projection().viewerCanRevealUncontested).toBe(false);
    expect(fixture.runtime.getProjection({ kind: "SPECTATOR" }).viewerCanRevealUncontested).toBe(false);
    expectExcludesCards(hiddenProjection, cards.A!);
    expectExcludesCards(hiddenProjection, cards.B!);

    await fixture.clients[winnerId]!.execute({
      type: RuntimeCommandType.RevealUncontested,
    });
    const revealedProjection = fixture.system.projection();
    expectContainsCards(revealedProjection, cards[winnerId]!);
    expectExcludesCards(revealedProjection, cards[foldingId]!);
    expect(revealedProjection.recentHands.at(-1)?.record.revealedHoleCards).toHaveLength(1);
  });

  it("preserves privacy through a deterministic multi-all-in Side Pot", async () => {
    const fixture = await startedRuntime(["A", "B", "C"]);
    await fixture.clients.A!.execute({
      type: RuntimeCommandType.HostAdjustChips,
      targetPlayerId: "B",
      amount: -50,
      ledgerEntryId: "short-b",
    });
    await fixture.clients.A!.execute({
      type: RuntimeCommandType.HostAdjustChips,
      targetPlayerId: "C",
      amount: 50,
      ledgerEntryId: "deep-c",
    });
    await startFirstHand(fixture, "side-pot");
    const cards = captureOwnCards(fixture, ["A", "B", "C"]);

    await fixture.clients.A!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.AllIn },
    });
    await fixture.clients.B!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.AllIn },
    });
    await fixture.clients.C!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Call },
    });

    const runoutProjection = fixture.system.projection();
    expect(runoutProjection.currentHand).toMatchObject({
      status: HandLifecycleStatus.RunoutRequired,
      potSize: 250,
    });
    for (const hand of Object.values(cards)) expectExcludesCards(runoutProjection, hand);
    for (const playerId of ["A", "B", "C"]) {
      const projection = fixture.clients[playerId]!.projection();
      expectContainsCards(projection, cards[playerId]!);
      for (const otherId of ["A", "B", "C"].filter((id) => id !== playerId)) {
        expectExcludesCards(projection, cards[otherId]!);
      }
    }

    await completeWithCallsAndChecks(fixture);
    const record = fixture.system.projection().recentHands.at(-1)!.record;
    expect(record.settlement?.pots).toHaveLength(2);
    expect(record.settlement?.totalPotAmount).toBe(250);
    expectNoRawStateKeys(fixture.system.projection());
  });
});

describe("projection read isolation", () => {
  it("returns frozen detached projections that cannot mutate runtime state", async () => {
    const fixture = await startedRuntime();
    const projection = fixture.system.projection();
    const version = fixture.runtime.version;
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.seats)).toBe(true);
    expect(() => {
      (projection.seats as unknown as unknown[])[0] = null;
    }).toThrow();
    expect(fixture.runtime.version).toBe(version);
    expect(fixture.system.projection().seats[0]?.playerId).toBe("A");
  });

  it("does not expose raw state through the runtime's enumerable surface", () => {
    const runtime = new SingleTableRuntime({ rngForHand: () => () => 0.5 });
    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toContain("activeHand");
    expect(serialized).not.toContain("privateHoleCards");
    expect(serialized).toBe("{}");
  });
});
