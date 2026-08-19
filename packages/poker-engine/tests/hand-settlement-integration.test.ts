import { describe, expect, it } from "vitest";

import {
  advanceRunout,
  HandCompletionReason,
  HandLifecycleStatus,
  PlayerActionType,
  settleHand,
} from "../src/index.js";
import { cardKey } from "./helpers.js";
import {
  actHand,
  finishByCallingAndChecking,
  privateCards,
  riggedRng,
  startOrchestratedHand,
} from "./hand-helpers.js";

function finishRunout(state: ReturnType<typeof startOrchestratedHand>) {
  let next = state;
  while (next.status === HandLifecycleStatus.RunoutRequired) next = advanceRunout(next);
  return next;
}

function stackOf(state: ReturnType<typeof startOrchestratedHand>, playerId: string): number {
  const stack = state.settlement?.finalStacks.find((entry) => entry.playerId === playerId)?.stack;
  if (stack === undefined) throw new Error(`Missing final stack for ${playerId}`);
  return stack;
}

describe("automatic settlement integration", () => {
  it("settles a normal heads-up Showdown after River action", () => {
    const rng = riggedRng(["Ks", "As", "Kd", "Ad", "2c", "4d", "7h", "9s", "Jc"]);
    const state = finishByCallingAndChecking(
      startOrchestratedHand([100, 100], { buttonSeat: 0, rng }),
    );
    expect(state.status).toBe(HandLifecycleStatus.Complete);
    expect(state.completionReason).toBe(HandCompletionReason.Showdown);
    expect(state.settlement?.pots[0]?.winnerPlayerIds).toEqual(["A"]);
    expect(stackOf(state, "A")).toBe(102);
    expect(stackOf(state, "B")).toBe(98);
    expect(state.settlement).toEqual(
      settleHand({
        state: state.bettingState,
        board: state.board,
        holeCards: Object.freeze(
          Object.fromEntries(
            state.privateHoleCards.map((hand) => [hand.playerId, hand.cards]),
          ),
        ),
      }),
    );
  });

  it("settles an uncontested preflop Fold immediately without revealing a board", () => {
    let state = startOrchestratedHand([100, 100], { buttonSeat: 0 });
    state = actHand(state, PlayerActionType.Fold);
    expect(state.status).toBe(HandLifecycleStatus.Complete);
    expect(state.completionReason).toBe(HandCompletionReason.Uncontested);
    expect(state.board).toEqual([]);
    expect(state.settlement?.evaluatedHands).toEqual([]);
    expect(stackOf(state, "A")).toBe(99);
    expect(stackOf(state, "B")).toBe(101);
  });

  it("creates one side pot: short stack wins main and B wins side", () => {
    const rng = riggedRng([
      "As", "Ks", "Jh", "Ad", "Kd", "Jd",
      "2c", "4d", "7h", "9s", "Jc",
    ]);
    let state = startOrchestratedHand([20, 50, 50], { buttonSeat: 0, rng });
    expect(privateCards(state, "A").map(cardKey)).toEqual(["11:h", "11:d"]);
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);
    state = finishRunout(state);

    expect(state.settlement?.pots.map(({ amount }) => amount)).toEqual([60, 60]);
    expect(state.settlement?.pots.map(({ winnerPlayerIds }) => winnerPlayerIds)).toEqual([
      ["A"],
      ["B"],
    ]);
    expect([stackOf(state, "A"), stackOf(state, "B"), stackOf(state, "C")]).toEqual([
      60, 60, 0,
    ]);
  });

  it("constructs and independently settles multiple side pots", () => {
    const rng = riggedRng([
      "As", "Ks", "9h", "8h", "Ad", "Kd", "9d", "8d",
      "2c", "4d", "7h", "8s", "9c",
    ]);
    let state = startOrchestratedHand([30, 30, 10, 20], { buttonSeat: 3, rng });
    state = actHand(state, PlayerActionType.AllIn); // C to 10
    state = actHand(state, PlayerActionType.AllIn); // D to 20
    state = actHand(state, PlayerActionType.AllIn); // A to 30
    state = actHand(state, PlayerActionType.Call); // B to 30
    state = finishRunout(state);

    expect(state.settlement?.pots.map(({ amount }) => amount)).toEqual([40, 30, 20]);
    expect(state.settlement?.pots.map(({ winnerPlayerIds }) => winnerPlayerIds)).toEqual([
      ["C"],
      ["D"],
      ["A"],
    ]);
    expect([stackOf(state, "A"), stackOf(state, "B"), stackOf(state, "C"), stackOf(state, "D")]).toEqual([
      20, 0, 40, 30,
    ]);
  });

  it("splits a pot using the settlement engine when the board is best", () => {
    const rng = riggedRng(["2c", "4c", "3c", "5c", "As", "Kd", "Qc", "Jh", "Ts"]);
    let state = startOrchestratedHand([10, 10], { rng });
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);
    state = finishRunout(state);

    expect(state.settlement?.pots[0]?.winnerPlayerIds).toHaveLength(2);
    expect(state.settlement?.totalPayouts.map(({ amount }) => amount)).toEqual([10, 10]);
  });

  it("conserves the starting stack total in every completed integration scenario", () => {
    const starts = [13, 29, 47];
    let state = startOrchestratedHand(starts, { buttonSeat: 0 });
    state = finishByCallingAndChecking(state);
    expect(state.settlement?.totalStartingStacks).toBe(starts.reduce((a, b) => a + b, 0));
    expect(state.settlement?.totalFinalStacks).toBe(starts.reduce((a, b) => a + b, 0));
  });
});
