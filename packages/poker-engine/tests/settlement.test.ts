import { describe, expect, it } from "vitest";

import {
  applyAction,
  BettingStatus,
  legalActions,
  PlayerActionType,
  settleHand,
  Street,
} from "../src/index.js";
import { startHand } from "./betting-helpers.js";
import { cards } from "./helpers.js";
import { amountFor, holeCards, settlementState, stackFor } from "./settlement-helpers.js";

const DRY_BOARD = cards("2c 4d 7h 9s Jc");

describe("normal and uncontested settlement", () => {
  it("awards a normal single pot to the best hand", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 10 },
      { playerId: "B", seat: 1, contribution: 10 },
    ]);
    const result = settleHand({
      state,
      board: DRY_BOARD,
      holeCards: holeCards({ A: "As Ad", B: "Ks Kd" }),
    });

    expect(result.pots[0]?.winnerPlayerIds).toEqual(["A"]);
    expect(amountFor(result.totalPayouts, "A")).toBe(20);
    expect(result.totalStartingStacks).toBe(result.totalFinalStacks);
  });

  it("settles an uncontested Fold win without board or hole cards", () => {
    const state = settlementState(
      [
        { playerId: "A", seat: 0, contribution: 20 },
        { playerId: "B", seat: 1, contribution: 12, folded: true },
        { playerId: "C", seat: 2, contribution: 12, folded: true },
      ],
      { status: BettingStatus.Uncontested },
    );
    const result = settleHand({ state });

    expect(result.evaluatedHands).toEqual([]);
    expect(result.pots.map(({ winnerPlayerIds }) => winnerPlayerIds)).toEqual([["A"]]);
    expect(amountFor(result.totalPayouts, "A")).toBe(36);
    expect(result.pots[0]?.amount).toBe(36);
    expect(result.pots[0]?.contributorPlayerIds).toEqual(["A", "B", "C"]);
    expect(result.totalRefund).toBe(8);
  });

  it("keeps folded chips in the pot but never awards them to the folded player", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 40, folded: true },
      { playerId: "B", seat: 1, contribution: 40 },
      { playerId: "C", seat: 2, contribution: 40 },
    ]);
    const result = settleHand({
      state,
      board: DRY_BOARD,
      holeCards: holeCards({ B: "Ks Kd", C: "Qs Qd" }),
    });

    expect(result.pots[0]?.contributorPlayerIds).toContain("A");
    expect(result.pots[0]?.eligiblePlayerIds).not.toContain("A");
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["B"]);
  });

  it("settles a real heads-up check-through state from the betting engine", () => {
    let state = startHand([100, 100], { buttonSeat: 0 });
    while (state.status === BettingStatus.Betting) {
      const legal = legalActions(state);
      state = applyAction(state, {
        playerId: legal.playerId,
        type: legal.canCheck ? PlayerActionType.Check : PlayerActionType.Call,
      });
    }
    expect(state.street).toBe(Street.River);
    expect(state.status).toBe(BettingStatus.ShowdownPending);

    const result = settleHand({
      state,
      board: DRY_BOARD,
      holeCards: holeCards({ A: "As Ad", B: "Ks Kd" }),
    });
    expect(result.totalContribution).toBe(4);
    expect(result.pots[0]?.amount).toBe(4);
    expect(stackFor(result.finalStacks, "A")).toBe(102);
    expect(stackFor(result.finalStacks, "B")).toBe(98);
  });
});

describe("showdown across main and side pots", () => {
  it("lets a short stack win the main pot while another player wins the side pot", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 20, stack: 0, allIn: true },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 50 },
    ]);
    const result = settleHand({
      state,
      board: DRY_BOARD,
      holeCards: holeCards({ A: "Jh Jd", B: "As Ad", C: "Ks Kd" }),
    });

    expect(result.pots.map(({ winnerPlayerIds }) => winnerPlayerIds)).toEqual([["A"], ["B"]]);
    expect(result.pots.map(({ amount }) => amount)).toEqual([60, 60]);
    expect(amountFor(result.totalPayouts, "A")).toBe(60);
    expect(amountFor(result.totalPayouts, "B")).toBe(60);
  });

  it("allows the same player to win multiple pots", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 20 },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 50 },
    ]);
    const result = settleHand({
      state,
      board: DRY_BOARD,
      holeCards: holeCards({ A: "Qs Qd", B: "As Ad", C: "Ks Kd" }),
    });
    expect(result.pots.map(({ winnerPlayerIds }) => winnerPlayerIds)).toEqual([["B"], ["B"]]);
    expect(amountFor(result.totalPayouts, "B")).toBe(120);
  });

  it("supports different winners across three nested pots", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 10 },
      { playerId: "B", seat: 1, contribution: 20 },
      { playerId: "C", seat: 2, contribution: 30 },
      { playerId: "D", seat: 3, contribution: 30 },
    ]);
    const result = settleHand({
      state,
      board: cards("2c 4d 7h 8s 9c"),
      holeCards: holeCards({ A: "9h 9d", B: "8h 8d", C: "As Ad", D: "Ks Kd" }),
    });
    expect(result.pots.map(({ winnerPlayerIds }) => winnerPlayerIds)).toEqual([
      ["A"],
      ["B"],
      ["C"],
    ]);
  });

  it("uses the board itself as the best five and ties exactly", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 10 },
      { playerId: "B", seat: 1, contribution: 10 },
    ]);
    const result = settleHand({
      state,
      board: cards("As Kd Qc Jh Ts"),
      holeCards: holeCards({ A: "2c 3c", B: "4d 5d" }),
    });
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["B", "A"]);
    expect(result.pots[0]?.payouts.map(({ amount }) => amount)).toEqual([10, 10]);
  });

  it("uses full kicker comparison to decide a pot", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 10 },
      { playerId: "B", seat: 1, contribution: 10 },
    ]);
    const result = settleHand({
      state,
      board: cards("Ah 7d 4c 3s 2h"),
      holeCards: holeCards({ A: "Ks Qs", B: "Js Ts" }),
    });
    expect(result.pots[0]?.winnerPlayerIds).toEqual(["A"]);
  });
});

describe("split pots", () => {
  it.each([
    { players: ["A", "B"], contribution: 6, expected: 6 },
    { players: ["A", "B", "C"], contribution: 6, expected: 6 },
  ])("splits evenly among $players.length tied winners", ({ players, contribution, expected }) => {
    const state = settlementState(
      players.map((playerId, seat) => ({ playerId, seat, contribution })),
    );
    const result = settleHand({
      state,
      board: cards("As Kd Qc Jh Ts"),
      holeCards: holeCards(
        Object.fromEntries(players.map((playerId, index) => [playerId, `${2 + index}c ${2 + index}d`])),
      ),
    });
    expect(result.pots[0]?.payouts.every(({ amount }) => amount === expected)).toBe(true);
  });

  it("ties the main pot while awarding the side pot only to B", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 20 },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 50 },
    ]);
    const result = settleHand({
      state,
      board: cards("Ah Kd 7c 4s 2h"),
      holeCards: holeCards({ A: "Qs Js", B: "Qc Jc", C: "Ts 9s" }),
    });
    expect(new Set(result.pots[0]?.winnerPlayerIds)).toEqual(new Set(["A", "B"]));
    expect(result.pots[1]?.winnerPlayerIds).toEqual(["B"]);
  });

  it("supports different tie groups in main and side pots", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 10 },
      { playerId: "B", seat: 1, contribution: 10 },
      { playerId: "C", seat: 2, contribution: 30 },
      { playerId: "D", seat: 3, contribution: 30 },
    ]);
    const result = settleHand({
      state,
      board: cards("Ah Kd 7c 4s 2h"),
      holeCards: holeCards({ A: "Qs Js", B: "Qc Jc", C: "Ts 9s", D: "Tc 9c" }),
    });
    expect(new Set(result.pots[0]?.winnerPlayerIds)).toEqual(new Set(["A", "B"]));
    expect(new Set(result.pots[1]?.winnerPlayerIds)).toEqual(new Set(["C", "D"]));
  });
});
