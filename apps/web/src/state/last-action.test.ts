import { describe, expect, it } from "vitest";
import type { PublicActionRecord } from "@friend-poker/shared";
import { getLastActionPresentation } from "./last-action.js";
import { projectionFixture } from "../test/fixtures.js";

function action(overrides: Partial<PublicActionRecord>): PublicActionRecord {
  return {
    type: "ACTION",
    playerId: "alice",
    sequence: 0,
    street: "PREFLOP",
    requestedType: "CALL",
    semantic: "CALL",
    amountCommitted: 2,
    toContribution: 2,
    isAllIn: false,
    isFullBetOrRaise: false,
    ...overrides,
  };
}

const projection = projectionFixture();

describe("getLastActionPresentation", () => {
  it("hides the surface when there are no voluntary actions", () => {
    expect(getLastActionPresentation(projection, { actions: [] })).toBeNull();
    expect(getLastActionPresentation(projection, null)).toBeNull();
  });

  it.each([
    ["FOLD", "弃牌", null],
    ["CHECK", "过牌", null],
    ["CALL", "跟注", 4],
    ["BET", "下注", 6],
    ["RAISE", "加注至", 12],
  ] as const)("formats %s using its semantic and authoritative amount", (semantic, label, amount) => {
    const result = getLastActionPresentation(projection, {
      actions: [
        action({
          semantic,
          requestedType: semantic,
          amountCommitted: semantic === "CALL" ? 4 : 6,
          toContribution: 12,
        }),
      ],
    });

    expect(result).toMatchObject({
      streetLabel: "翻牌前",
      nickname: "Alice",
      actionLabel: label,
      amount,
      isAllIn: false,
    });
  });

  it.each([
    ["CALL", "跟注", 8],
    ["BET", "下注", 20],
    ["RAISE", "加注至", 20],
  ] as const)("formats semantic %s All-in without using requested ALL_IN", (semantic, label, amount) => {
    const result = getLastActionPresentation(projection, {
      actions: [
        action({
          requestedType: "ALL_IN",
          semantic,
          amountCommitted: semantic === "CALL" ? 8 : 20,
          toContribution: 20,
          isAllIn: true,
        }),
      ],
    });

    expect(result).toMatchObject({ actionLabel: label, amount, isAllIn: true });
  });

  it("uses the action street, safe nickname, and newest sequence", () => {
    const result = getLastActionPresentation(projection, {
      actions: [
        action({ sequence: 2, street: "FLOP", semantic: "CHECK" }),
        action({ sequence: 4, street: "TURN", playerId: "bob", semantic: "RAISE", toContribution: 12 }),
      ],
    });

    expect(result).toMatchObject({
      sequence: 4,
      streetLabel: "转牌",
      nickname: "Bob",
      actionLabel: "加注至",
      amount: 12,
    });
  });
});
