import { describe, expect, it } from "vitest";

import { createDeck, shuffleDeck, startHand } from "../src/index.js";
import { cardKey, seededRandom } from "./helpers.js";
import {
  assertCardAccounting,
  finishByCallingAndChecking,
  privateCards,
  startOrchestratedHand,
} from "./hand-helpers.js";

describe("orchestrated hole-card dealing", () => {
  it.each([
    { count: 2, buttonSeat: 0 },
    { count: 3, buttonSeat: 1 },
    { count: 6, buttonSeat: 4 },
  ])("deals exactly two cards to each of $count players", ({ count, buttonSeat }) => {
    const state = startOrchestratedHand(Array.from({ length: count }, () => 100), {
      buttonSeat,
    });
    expect(state.privateHoleCards).toHaveLength(count);
    expect(state.privateHoleCards.every(({ cards }) => cards.length === 2)).toBe(true);
    expect(state.remainingDeck).toHaveLength(52 - count * 2);
    assertCardAccounting(state);
  });

  it("deals first clockwise left of Button, one complete round at a time", () => {
    const seed = 0x11ef_7001;
    const shuffled = shuffleDeck(createDeck(), seededRandom(seed));
    const state = startOrchestratedHand([100, 100, 100], {
      buttonSeat: 4,
      seats: [1, 4, 9],
      rng: seededRandom(seed),
    });

    expect(state.privateHoleCards.map(({ playerId }) => playerId)).toEqual(["C", "A", "B"]);
    expect(privateCards(state, "C")).toEqual([shuffled[0], shuffled[3]]);
    expect(privateCards(state, "A")).toEqual([shuffled[1], shuffled[4]]);
    expect(privateCards(state, "B")).toEqual([shuffled[2], shuffled[5]]);
  });

  it("uses the BB first when dealing heads-up from a Button/SB", () => {
    const state = startOrchestratedHand([100, 100], { buttonSeat: 0 });
    expect(state.privateHoleCards.map(({ playerId }) => playerId)).toEqual(["B", "A"]);
  });

  it("repeats exactly with the same deterministic RNG", () => {
    const first = startOrchestratedHand([100, 75, 50], { rng: seededRandom(991) });
    const second = startOrchestratedHand([100, 75, 50], { rng: seededRandom(991) });
    expect(second).toEqual(first);
  });

  it("does not mutate participant input", () => {
    const participants = Object.freeze([
      Object.freeze({ playerId: "A", seat: 0, stack: 100 }),
      Object.freeze({ playerId: "B", seat: 1, stack: 100 }),
    ]);
    const before = JSON.stringify(participants);
    startHand(
      { handId: "immutable", participants, buttonSeat: 0, smallBlind: 1, bigBlind: 2 },
      seededRandom(7),
    );
    expect(JSON.stringify(participants)).toBe(before);
  });

  it("keeps all dealt cards unique", () => {
    const state = startOrchestratedHand([100, 100, 100, 100, 100, 100]);
    const dealt = state.privateHoleCards.flatMap(({ cards }) => cards);
    expect(new Set(dealt.map(cardKey)).size).toBe(12);
    assertCardAccounting(state);
  });

  it("never overlaps hole cards, board cards, and remaining deck", () => {
    const state = finishByCallingAndChecking(
      startOrchestratedHand([100, 100, 100, 100]),
    );
    const holes = new Set(
      state.privateHoleCards.flatMap(({ cards }) => cards.map(cardKey)),
    );
    const board = new Set(state.board.map(cardKey));
    const remaining = new Set(state.remainingDeck.map(cardKey));
    expect([...holes].some((key) => board.has(key) || remaining.has(key))).toBe(false);
    expect([...board].some((key) => remaining.has(key))).toBe(false);
  });
});
