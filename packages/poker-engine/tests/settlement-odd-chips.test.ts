import { describe, expect, it } from "vitest";

import { settleHand } from "../src/index.js";
import { cards } from "./helpers.js";
import { holeCards, settlementState } from "./settlement-helpers.js";

const TIE_BOARD = cards("As Kd Qc Jh Ts");

function tieSettlement(
  seats: readonly number[],
  folded: ReadonlySet<number>,
  buttonSeat: number,
) {
  const ids = ["A", "B", "C", "D", "E", "F"].slice(0, seats.length);
  const state = settlementState(
    ids.map((playerId, index) => ({
      playerId,
      seat: seats[index]!,
      contribution: 1,
      folded: folded.has(index),
    })),
    { buttonSeat },
  );
  const active = ids.filter((_, index) => !folded.has(index));
  const notation = ["2c 3c", "4c 5c", "6c 7c", "8c 9c", "2d 3d", "4d 5d"];
  return settleHand({
    state,
    board: TIE_BOARD,
    holeCards: holeCards(
      Object.fromEntries(active.map((playerId, index) => [playerId, notation[index]!])),
    ),
  });
}

describe("odd-chip distribution", () => {
  it("splits a 5-chip pot between two winners and gives the odd chip left of Button", () => {
    const result = tieSettlement([0, 1, 2, 3, 4], new Set([1, 3, 4]), 4);
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["A", "C"]);
    expect(result.pots[0]?.payouts).toEqual([
      { playerId: "A", amount: 3, oddChips: 1 },
      { playerId: "C", amount: 2, oddChips: 0 },
    ]);
  });

  it("gives two remainder chips to the first two of three tied winners", () => {
    const result = tieSettlement([0, 1, 2, 3, 4], new Set([3, 4]), 4);
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["A", "B", "C"]);
    expect(result.pots[0]?.payouts.map(({ amount, oddChips }) => ({ amount, oddChips }))).toEqual([
      { amount: 2, oddChips: 1 },
      { amount: 2, oddChips: 1 },
      { amount: 1, oddChips: 0 },
    ]);
  });

  it("starts with a tied winner adjacent to the Button", () => {
    const result = tieSettlement([0, 1, 2, 3, 4], new Set([0, 2, 4]), 0);
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["B", "D"]);
    expect(result.pots[0]?.payouts[0]).toMatchObject({ playerId: "B", oddChips: 1 });
  });

  it("skips the Button when it is not in the tie", () => {
    const result = tieSettlement([0, 1, 2, 3, 4], new Set([2, 3, 4]), 2);
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["A", "B"]);
    expect(result.pots[0]?.payouts[0]).toMatchObject({ playerId: "A", oddChips: 1 });
  });

  it("uses clockwise seat order with sparse seats and wraparound", () => {
    const result = tieSettlement([1, 4, 9, 15, 22], new Set([0, 1, 3]), 15);
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["E", "C"]);
    expect(result.pots[0]?.payouts[0]).toMatchObject({ playerId: "E", oddChips: 1 });
  });

  it("never uses input insertion order to choose the odd chip", () => {
    const result = tieSettlement([9, 1, 7, 3, 5], new Set([1, 3, 4]), 5);
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["C", "A"]);
    expect(result.pots[0]?.payouts[0]).toMatchObject({ playerId: "C", oddChips: 1 });
  });
});
