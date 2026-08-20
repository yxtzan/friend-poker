import { describe, expect, it } from "vitest";
import type {
  PublicSafeHandRecord,
  PublicTableHandRecord,
  SafeTableProjection,
} from "@friend-poker/shared";
import { projectionFixture } from "../test/fixtures.js";
import {
  detectNewlyCompletedHand,
  detectStreetReveal,
  handCategoryLabel,
} from "./presentations.js";

const flop = [
  { rank: 2, suit: "c" },
  { rank: 7, suit: "d" },
  { rank: 11, suit: "h" },
] as const;
const turn = { rank: 4, suit: "s" } as const;
const river = { rank: 14, suit: "c" } as const;

function projectionWithBoard(
  version: number,
  board: NonNullable<SafeTableProjection["currentHand"]>["board"],
  handId = "hand-1",
): SafeTableProjection {
  const projection = projectionFixture();
  return {
    ...projection,
    version,
    currentHand: {
      ...projection.currentHand!,
      handId,
      board,
    },
  };
}

function settledHand(overrides: Partial<PublicSafeHandRecord> = {}): PublicTableHandRecord {
  return {
    sessionId: "session-1",
    handNumber: 8,
    record: {
      handId: "hand-8",
      participants: [
        { playerId: "alice", nickname: "Alice", seat: 0, startingStack: 100 },
        { playerId: "bob", nickname: "Bob", seat: 2, startingStack: 100 },
      ],
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 2,
      smallBlind: 1,
      bigBlind: 2,
      actions: [],
      board: [...flop, turn, river],
      flop: [...flop],
      turn,
      river,
      events: [],
      completionReason: "SHOWDOWN",
      settlement: {
        refunds: [],
        pots: [],
        evaluatedHands: [],
        totalPayouts: [{ playerId: "alice", amount: 200 }],
        finalStacks: [],
        totalContribution: 200,
        totalRefund: 0,
        totalPotAmount: 200,
        totalPotPayout: 200,
        totalStartingStacks: 200,
        totalFinalStacks: 200,
      },
      revealedHoleCards: [],
      ...overrides,
    },
  };
}

describe("presentation transition detection", () => {
  it("reveals exactly the cards added at flop, turn, and river", () => {
    const preflop = projectionWithBoard(1, []);
    const flopProjection = projectionWithBoard(2, [...flop]);
    const turnProjection = projectionWithBoard(3, [...flop, turn]);
    const riverProjection = projectionWithBoard(4, [...flop, turn, river]);

    expect(detectStreetReveal(preflop, flopProjection)).toMatchObject({ street: "FLOP", cards: flop });
    expect(detectStreetReveal(flopProjection, turnProjection)).toMatchObject({ street: "TURN", cards: [turn] });
    expect(detectStreetReveal(turnProjection, riverProjection)).toMatchObject({ street: "RIVER", cards: [river] });
  });

  it("reveals a river committed with the completed safe record when currentHand clears", () => {
    const turnProjection = projectionWithBoard(8, [...flop, turn], "hand-8");
    const completed = {
      ...projectionFixture({ version: 9, currentHand: null }),
      recentHands: [settledHand()],
    };
    expect(detectStreetReveal(turnProjection, completed)).toMatchObject({ street: "RIVER", cards: [river] });
  });

  it("ignores initial, stale, replayed, invalid, and unrelated hand projections", () => {
    const preflop = projectionWithBoard(5, []);
    const flopProjection = projectionWithBoard(6, [...flop]);
    expect(detectStreetReveal(null, flopProjection)).toBeNull();
    expect(detectStreetReveal(flopProjection, projectionWithBoard(6, [...flop]))).toBeNull();
    expect(detectStreetReveal(flopProjection, projectionWithBoard(5, [...flop, turn]))).toBeNull();
    expect(detectStreetReveal(preflop, projectionWithBoard(6, [...flop, turn]))).toBeNull();
    expect(detectStreetReveal(flopProjection, projectionWithBoard(7, [...flop], "hand-2"))).toBeNull();
  });

  it("detects only a newly appended completed safe hand record", () => {
    const previous = projectionFixture({ version: 10, recentHands: [] });
    const record = settledHand();
    const next = projectionFixture({ version: 11, recentHands: [record] });
    expect(detectNewlyCompletedHand(previous, next)).toBe(record);
    expect(detectNewlyCompletedHand(next, projectionFixture({ version: 12, recentHands: [record] }))).toBeNull();
    expect(detectNewlyCompletedHand(null, next)).toBeNull();
    expect(detectNewlyCompletedHand(next, projectionFixture({ version: 10, recentHands: [record] }))).toBeNull();
    expect(
      detectNewlyCompletedHand(
        previous,
        projectionFixture({ version: 11, recentHands: [settledHand({ settlement: null })] }),
      ),
    ).toBeNull();
  });
});

describe("hand category labels", () => {
  it("keeps the Chinese labels aligned with engine categories", () => {
    expect(handCategoryLabel(8, [14])).toBe("皇家同花顺");
    expect(handCategoryLabel(8, [13])).toBe("同花顺");
    expect(handCategoryLabel(6)).toBe("葫芦");
    expect(handCategoryLabel(0)).toBe("高牌");
  });
});
