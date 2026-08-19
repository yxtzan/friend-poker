import { describe, expect, it } from "vitest";

import { BettingStatus, settleHand, SettlementRuleError } from "../src/index.js";
import { cards } from "./helpers.js";
import { holeCards, settlementState } from "./settlement-helpers.js";

const state = settlementState([
  { playerId: "A", seat: 0, contribution: 10 },
  { playerId: "B", seat: 1, contribution: 10 },
]);

describe("settlement card validation", () => {
  it.each(["2c 3d 4h 5s", "2c 3d 4h 5s 6c 7d"])(
    "rejects a board that does not contain exactly five cards: %s",
    (board) => {
      expect(() =>
        settleHand({
          state,
          board: cards(board),
          holeCards: holeCards({ A: "As Ad", B: "Ks Kd" }),
        }),
      ).toThrow(/exactly five board cards/u);
    },
  );

  it.each(["As", "As Ad Ah"])("rejects non-two-card hole input: %s", (hole) => {
    expect(() =>
      settleHand({
        state,
        board: cards("2c 3d 4h 5s 6c"),
        holeCards: holeCards({ A: hole, B: "Ks Kd" }),
      }),
    ).toThrow(/exactly two hole cards/u);
  });

  it("rejects a duplicate board card", () => {
    expect(() =>
      settleHand({
        state,
        board: cards("2c 2c 4h 5s 6c"),
        holeCards: holeCards({ A: "As Ad", B: "Ks Kd" }),
      }),
    ).toThrow(/duplicate cards/u);
  });

  it("rejects a hole card duplicated on the board", () => {
    expect(() =>
      settleHand({
        state,
        board: cards("2c 3d 4h 5s 6c"),
        holeCards: holeCards({ A: "2c Ad", B: "Ks Kd" }),
      }),
    ).toThrow(/duplicate cards/u);
  });

  it("rejects a duplicate between two players' hole cards", () => {
    expect(() =>
      settleHand({
        state,
        board: cards("2c 3d 4h 5s 6c"),
        holeCards: holeCards({ A: "As Ad", B: "As Kd" }),
      }),
    ).toThrow(/duplicate cards/u);
  });

  it("does not require or expose a folded player's cards", () => {
    const foldedState = settlementState([
      { playerId: "A", seat: 0, contribution: 10, folded: true },
      { playerId: "B", seat: 1, contribution: 10 },
      { playerId: "C", seat: 2, contribution: 10 },
    ]);
    const result = settleHand({
      state: foldedState,
      board: cards("2c 3d 4h 5s 7c"),
      holeCards: holeCards({ B: "As Ad", C: "Ks Kd" }),
    });
    expect(result.evaluatedHands.map(({ playerId }) => playerId)).toEqual(["B", "C"]);
    expect(result).not.toHaveProperty("holeCards");
  });

  it("rejects a state that is still awaiting betting action", () => {
    const bettingState = {
      ...state,
      status: BettingStatus.Betting,
      currentActorId: "A",
    } as const;
    expect(() => settleHand({ state: bettingState })).toThrow(SettlementRuleError);
  });

  it("rejects a mathematically impossible matched pot with no eligible winner", () => {
    const impossible = settlementState([
      { playerId: "A", seat: 0, contribution: 100, folded: true },
      { playerId: "B", seat: 1, contribution: 100, folded: true },
      { playerId: "C", seat: 2, contribution: 40 },
    ]);
    expect(() => settleHand({ state: impossible })).toThrow(/no eligible winner/u);
  });
});
