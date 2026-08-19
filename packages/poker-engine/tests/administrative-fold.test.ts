import { describe, expect, it } from "vitest";

import {
  AdministrativeFoldReason,
  administrativelyFoldHandParticipant,
  administrativelyFoldTableParticipant,
  advanceRunout,
  applyHandAction,
  getHandRecord,
  HandLifecycleStatus,
  PlayerActionType,
  startFirstHand,
} from "../src/index.js";
import { startOrchestratedHand } from "./hand-helpers.js";
import { player, rng, startedSession } from "./table-helpers.js";

describe("administrative Fold integration boundary", () => {
  it("folds a non-current participant without moving the current actor or refunding chips", () => {
    let state = startFirstHand(
      startedSession(["A", "B", "C"]),
      { operatorPlayerId: "A", handId: "admin-fold", buttonSeat: 0 },
      rng(8),
    );
    const actorBefore = state.activeHand!.bettingState.currentActorId;
    const targetBefore = state.activeHand!.bettingState.participants.find(
      ({ playerId }) => playerId === "B",
    )!;

    state = administrativelyFoldTableParticipant(state, {
      targetPlayerId: "B",
      reason: AdministrativeFoldReason.Kick,
      operatorPlayerId: "A",
    });

    const targetAfter = state.activeHand!.bettingState.participants.find(
      ({ playerId }) => playerId === "B",
    )!;
    expect(targetAfter.folded).toBe(true);
    expect(targetAfter.totalContribution).toBe(targetBefore.totalContribution);
    expect(targetAfter.stack).toBe(targetBefore.stack);
    expect(state.activeHand!.bettingState.currentActorId).toBe(actorBefore);
    expect(player(state, "B").chipBalance).toBe(100);
    expect(state.activeHand!.events.at(-1)).toMatchObject({
      type: "ADMINISTRATIVE_FOLD",
      handId: "admin-fold",
      targetPlayerId: "B",
      reason: "KICK",
      operatorPlayerId: "A",
    });
  });

  it("advances correctly when the current actor is administratively folded", () => {
    let state = startFirstHand(
      startedSession(["A", "B", "C"]),
      { operatorPlayerId: "A", handId: "current-admin-fold", buttonSeat: 0 },
      rng(9),
    );
    expect(state.activeHand!.bettingState.currentActorId).toBe("A");
    state = administrativelyFoldTableParticipant(state, {
      targetPlayerId: "A",
      reason: AdministrativeFoldReason.DisconnectTimeout,
      operatorPlayerId: null,
    });
    expect(state.activeHand!.bettingState.currentActorId).toBe("B");
    expect(state.activeHand!.bettingState.participants[0]?.folded).toBe(true);
  });

  it("settles an uncontested Fold exactly once and retains a safe audit record", () => {
    let state = startFirstHand(
      startedSession(),
      { operatorPlayerId: "A", handId: "uncontested-admin-fold", buttonSeat: 0 },
      rng(10),
    );
    state = administrativelyFoldTableParticipant(state, {
      targetPlayerId: "A",
      reason: AdministrativeFoldReason.HostForceFold,
      operatorPlayerId: "B",
    });
    expect(state.activeHand).toBeNull();
    expect(state.recentHands).toHaveLength(1);
    const record = state.recentHands[0]!.record;
    expect(record.events.filter(({ type }) => type === "HAND_SETTLED")).toHaveLength(1);
    expect(record.events).toContainEqual(
      expect.objectContaining({
        type: "ADMINISTRATIVE_FOLD",
        reason: "HOST_FORCE_FOLD",
        operatorPlayerId: "B",
      }),
    );
    expect(record).not.toHaveProperty("privateHoleCards");
    expect(record).not.toHaveProperty("remainingDeck");
  });

  it("keeps an administratively folded all-in contribution in Side Pots but excludes the player", () => {
    let hand = startOrchestratedHand([5, 10, 20], { handId: "admin-side-pot" });
    hand = applyHandAction(hand, { playerId: "A", type: PlayerActionType.AllIn });
    hand = applyHandAction(hand, { playerId: "B", type: PlayerActionType.AllIn });
    const contributed = hand.bettingState.participants.find(
      ({ playerId }) => playerId === "B",
    )!.totalContribution;
    hand = administrativelyFoldHandParticipant(hand, {
      targetPlayerId: "B",
      reason: AdministrativeFoldReason.Kick,
      operatorPlayerId: "A",
    });
    expect(
      hand.bettingState.participants.find(({ playerId }) => playerId === "B")!
        .totalContribution,
    ).toBe(contributed);
    hand = applyHandAction(hand, { playerId: "C", type: PlayerActionType.Call });
    while (hand.status === HandLifecycleStatus.RunoutRequired) hand = advanceRunout(hand);

    expect(hand.status).toBe(HandLifecycleStatus.Complete);
    expect(hand.settlement!.finalStacks.reduce((sum, stack) => sum + stack.stack, 0)).toBe(35);
    expect(
      hand.settlement!.totalPayouts.find(({ playerId }) => playerId === "B")?.amount,
    ).toBe(0);
    expect(
      hand.settlement!.pots.every(
        (pot) => !pot.eligiblePlayerIds.includes("B"),
      ),
    ).toBe(true);
    expect(getHandRecord(hand).events).toContainEqual(
      expect.objectContaining({ type: "ADMINISTRATIVE_FOLD", reason: "KICK" }),
    );
  });

  it("composes with an already-started All-in Runout", () => {
    let hand = startOrchestratedHand([5, 5, 5], { handId: "admin-runout" });
    hand = applyHandAction(hand, { playerId: "A", type: PlayerActionType.AllIn });
    hand = applyHandAction(hand, { playerId: "B", type: PlayerActionType.AllIn });
    hand = applyHandAction(hand, { playerId: "C", type: PlayerActionType.Call });
    expect(hand.status).toBe(HandLifecycleStatus.RunoutRequired);

    hand = administrativelyFoldHandParticipant(hand, {
      targetPlayerId: "B",
      reason: AdministrativeFoldReason.ExplicitLeave,
      operatorPlayerId: "B",
    });
    expect(hand.status).toBe(HandLifecycleStatus.RunoutRequired);
    expect(
      hand.bettingState.participants.find(({ playerId }) => playerId === "B")?.folded,
    ).toBe(true);
    while (hand.status === HandLifecycleStatus.RunoutRequired) hand = advanceRunout(hand);
    expect(hand.settlement?.totalFinalStacks).toBe(15);
    expect(
      hand.settlement?.totalPayouts.find(({ playerId }) => playerId === "B")?.amount,
    ).toBe(0);
  });
});
