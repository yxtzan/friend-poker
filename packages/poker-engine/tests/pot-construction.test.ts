import { describe, expect, it } from "vitest";

import { constructPots, normalizeContributions, PotKind } from "../src/index.js";
import { amountFor, settlementState } from "./settlement-helpers.js";

describe("contribution normalization and unmatched refunds", () => {
  it("refunds 30 for A 70 versus B 40 and leaves a matched pot of 80", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 70 },
      { playerId: "B", seat: 1, contribution: 40 },
    ]);
    const result = constructPots(state.participants);

    expect(amountFor(result.refunds, "A")).toBe(30);
    expect(amountFor(result.refunds, "B")).toBe(0);
    expect(result.pots).toHaveLength(1);
    expect(result.pots[0]).toMatchObject({ amount: 80, contributionFrom: 0, contributionTo: 40 });
  });

  it("refunds only the unique highest contribution layer", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 20 },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 100 },
    ]);
    const result = normalizeContributions(state.participants);

    expect(result.contributions.map(({ matchedAmount }) => matchedAmount)).toEqual([20, 50, 50]);
    expect(result.refunds.map(({ amount }) => amount)).toEqual([0, 0, 50]);
    expect(result.totalContribution).toBe(170);
    expect(result.totalMatched).toBe(120);
  });

  it("does not refund when the highest contribution is matched", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 50 },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 20 },
    ]);
    expect(normalizeContributions(state.participants).totalRefund).toBe(0);
  });

  it("refunds a folded player's unmatched excess without removing matched chips", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 100, folded: true },
      { playerId: "B", seat: 1, contribution: 40 },
      { playerId: "C", seat: 2, contribution: 40 },
    ]);
    const result = constructPots(state.participants);

    expect(amountFor(result.refunds, "A")).toBe(60);
    expect(result.pots).toHaveLength(1);
    expect(result.pots[0]).toMatchObject({
      amount: 120,
      contributorPlayerIds: ["A", "B", "C"],
      eligiblePlayerIds: ["B", "C"],
    });
  });

  it("refunds an entire contribution when no opponent matched any of it", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 25 },
      { playerId: "B", seat: 1, contribution: 0, folded: true },
    ]);
    const result = constructPots(state.participants);
    expect(result.totalRefund).toBe(25);
    expect(result.pots).toEqual([]);
  });
});

describe("arbitrary contribution-level pot construction", () => {
  it("constructs a heads-up equal-contribution main pot", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 12 },
      { playerId: "B", seat: 1, contribution: 12 },
    ]);
    expect(constructPots(state.participants).pots).toEqual([
      expect.objectContaining({
        potIndex: 0,
        kind: PotKind.Main,
        contributionFrom: 0,
        contributionTo: 12,
        amount: 24,
        contributorPlayerIds: ["A", "B"],
        eligiblePlayerIds: ["A", "B"],
      }),
    ]);
  });

  it("constructs a 3-player equal-contribution main pot", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 7 },
      { playerId: "B", seat: 1, contribution: 7 },
      { playerId: "C", seat: 2, contribution: 7 },
    ]);
    expect(constructPots(state.participants).pots[0]?.amount).toBe(21);
  });

  it("constructs one side pot for 20 / 50 / 50", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 20 },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 50 },
    ]);
    expect(constructPots(state.participants).pots).toEqual([
      expect.objectContaining({ amount: 60, contributionFrom: 0, contributionTo: 20, eligiblePlayerIds: ["A", "B", "C"] }),
      expect.objectContaining({ amount: 60, contributionFrom: 20, contributionTo: 50, eligiblePlayerIds: ["B", "C"] }),
    ]);
  });

  it("constructs every layer for 10 / 30 / 60 / 100", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 10 },
      { playerId: "B", seat: 1, contribution: 30 },
      { playerId: "C", seat: 2, contribution: 60 },
      { playerId: "D", seat: 3, contribution: 100 },
    ]);
    const result = constructPots(state.participants);

    expect(result.pots.map(({ amount }) => amount)).toEqual([40, 60, 60]);
    expect(result.pots.map(({ contributionTo }) => contributionTo)).toEqual([10, 30, 60]);
    expect(result.pots.map(({ eligiblePlayerIds }) => eligiblePlayerIds)).toEqual([
      ["A", "B", "C", "D"],
      ["B", "C", "D"],
      ["C", "D"],
    ]);
    expect(amountFor(result.refunds, "D")).toBe(40);
  });

  it("supports gaps, zero contributions, folds, and input order without changing seat order", () => {
    const state = settlementState([
      { playerId: "D", seat: 9, contribution: 20 },
      { playerId: "A", seat: 1, contribution: 0, folded: true },
      { playerId: "C", seat: 7, contribution: 10, folded: true },
      { playerId: "B", seat: 4, contribution: 20 },
    ]);
    const result = constructPots(state.participants);
    expect(result.pots.map(({ amount }) => amount)).toEqual([30, 20]);
    expect(result.pots[0]?.contributorPlayerIds).toEqual(["B", "C", "D"]);
    expect(result.pots[0]?.eligiblePlayerIds).toEqual(["B", "D"]);
  });

  it("never mutates caller-owned participants", () => {
    const state = settlementState([
      { playerId: "A", seat: 0, contribution: 20 },
      { playerId: "B", seat: 1, contribution: 50 },
      { playerId: "C", seat: 2, contribution: 100 },
    ]);
    const before = JSON.stringify(state.participants);
    constructPots(state.participants);
    expect(JSON.stringify(state.participants)).toBe(before);
  });
});
