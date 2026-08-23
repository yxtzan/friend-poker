import { describe, expect, it } from "vitest";
import type {
  PublicActionRecord,
  PublicSafeHandRecord,
  PublicTableHandRecord,
} from "@friend-poker/shared";
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

function activeProjection(actions: readonly PublicActionRecord[]) {
  return projectionFixture({
    currentHand: { ...projection.currentHand!, actions },
  });
}

function completedHand(overrides: Partial<PublicSafeHandRecord> = {}): PublicTableHandRecord {
  return {
    sessionId: "session-1",
    handNumber: 3,
    record: {
      handId: "hand-3",
      participants: [
        { playerId: "alice", nickname: "Alice", seat: 0, startingStack: 100 },
        { playerId: "bob", nickname: "Bob 历史名", seat: 2, startingStack: 100 },
      ],
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 2,
      smallBlind: 1,
      bigBlind: 2,
      actions: [],
      board: [],
      flop: [],
      turn: null,
      river: null,
      events: [],
      completionReason: "UNCONTESTED",
      settlement: null,
      revealedHoleCards: [],
      ...overrides,
    },
  };
}

describe("getLastActionPresentation", () => {
  it("hides the surface when there are no voluntary actions", () => {
    expect(getLastActionPresentation(activeProjection([]))).toBeNull();
    expect(getLastActionPresentation(projectionFixture({ currentHand: null }))).toBeNull();
  });

  it.each([
    ["FOLD", "弃牌", null],
    ["CHECK", "过牌", null],
    ["CALL", "跟注", 4],
    ["BET", "下注", 6],
    ["RAISE", "加注至", 12],
  ] as const)("formats %s using its semantic and authoritative amount", (semantic, label, amount) => {
    const result = getLastActionPresentation(activeProjection([
      action({
        semantic,
        requestedType: semantic,
        amountCommitted: semantic === "CALL" ? 4 : 6,
        toContribution: 12,
      }),
    ]));

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
    const result = getLastActionPresentation(activeProjection([
      action({
        requestedType: "ALL_IN",
        semantic,
        amountCommitted: semantic === "CALL" ? 8 : 20,
        toContribution: 20,
        isAllIn: true,
      }),
    ]));

    expect(result).toMatchObject({ actionLabel: label, amount, isAllIn: true });
  });

  it("uses the action street, safe nickname, and newest sequence", () => {
    const result = getLastActionPresentation(activeProjection([
      action({ sequence: 2, street: "FLOP", semantic: "CHECK" }),
      action({ sequence: 4, street: "TURN", playerId: "bob", semantic: "RAISE", toContribution: 12 }),
    ]));

    expect(result).toMatchObject({
      sequence: 4,
      streetLabel: "转牌",
      nickname: "Bob",
      actionLabel: "加注至",
      amount: 12,
    });
  });

  it("keeps the final Fold visible after atomic hand completion", () => {
    const finalFold = action({ playerId: "bob", sequence: 6, requestedType: "FOLD", semantic: "FOLD" });
    const projection = projectionFixture({
      status: "BETWEEN_HANDS",
      currentHand: null,
      seats: [null, null, null, null, null, null],
      spectators: [],
      recentHands: [completedHand({ actions: [finalFold] })],
    });

    expect(getLastActionPresentation(projection)).toMatchObject({
      sequence: 6,
      streetLabel: "翻牌前",
      nickname: "Bob 历史名",
      actionLabel: "弃牌",
      amount: null,
    });
  });

  it("keeps a final River Call visible through unrelated between-hand updates", () => {
    const finalCall = action({
      playerId: "bob",
      sequence: 9,
      street: "RIVER",
      semantic: "CALL",
      requestedType: "CALL",
      amountCommitted: 4,
    });
    const completed = completedHand({ actions: [finalCall] });
    const first = projectionFixture({ status: "BETWEEN_HANDS", currentHand: null, recentHands: [completed] });
    const later = projectionFixture({
      version: 99,
      status: "BETWEEN_HANDS",
      currentHand: null,
      recentHands: [completed],
      seats: [null, null, null, null, null, null],
      spectators: [],
    });

    expect(getLastActionPresentation(first)).toMatchObject({ streetLabel: "河牌", nickname: "Bob 历史名", amount: 4 });
    expect(getLastActionPresentation(later)).toMatchObject({ streetLabel: "河牌", nickname: "Bob 历史名", amount: 4 });
  });

  it("clears the completed action when a new hand starts, then shows the new action", () => {
    const finalFold = action({ playerId: "bob", sequence: 6, requestedType: "FOLD", semantic: "FOLD" });
    const betweenHands = projectionFixture({
      status: "BETWEEN_HANDS",
      currentHand: null,
      recentHands: [completedHand({ actions: [finalFold] })],
    });
    const newHand = projectionFixture({
      status: "HAND_IN_PROGRESS",
      currentHand: { ...projection.currentHand!, handId: "hand-4", actions: [] },
      recentHands: betweenHands.recentHands,
    });
    const firstAction = action({ playerId: "alice", sequence: 1, semantic: "CALL", amountCommitted: 2 });
    const newHandAfterAction = {
      ...newHand,
      currentHand: { ...newHand.currentHand!, actions: [firstAction] },
    };

    expect(getLastActionPresentation(betweenHands)).not.toBeNull();
    expect(getLastActionPresentation(newHand)).toBeNull();
    expect(getLastActionPresentation(newHandAfterAction)).toMatchObject({ nickname: "Alice", actionLabel: "跟注", amount: 2 });
  });

  it("does not surface a completed action from another Session", () => {
    const wrongHandNumber = { ...completedHand({ actions: [action({ playerId: "alice", semantic: "CHECK", requestedType: "CHECK" })] }), handNumber: 2 };
    const oldSession = { ...completedHand({ actions: [action({ playerId: "bob", semantic: "FOLD", requestedType: "FOLD" })] }), sessionId: "old-session" };
    const projection = projectionFixture({ status: "BETWEEN_HANDS", currentHand: null, recentHands: [wrongHandNumber, oldSession] });

    expect(getLastActionPresentation(projection)).toBeNull();
  });
});
