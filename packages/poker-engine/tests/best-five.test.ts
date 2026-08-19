import { describe, expect, it } from "vitest";

import { evaluateBestHand, HandCategory } from "../src/index.js";
import type { Card } from "../src/index.js";
import { cardKey, cards } from "./helpers.js";

function keys(cardsToKey: readonly Card[]): string[] {
  return cardsToKey.map(cardKey).sort();
}

describe("best-five selection", () => {
  it("selects the best five from six supplied cards", () => {
    const result = evaluateBestHand(cards("As Kd Qc Jh Ts 2d"));
    expect(result.category).toBe(HandCategory.Straight);
    expect(keys(result.bestFive)).toEqual(keys(cards("As Kd Qc Jh Ts")));
  });

  it("selects the best five from seven supplied cards", () => {
    const result = evaluateBestHand(cards("As Ah Ad Kc Kh 2s 3d"));
    expect(result.category).toBe(HandCategory.FullHouse);
    expect(result.tiebreakers).toEqual([14, 13]);
    expect(keys(result.bestFive)).toEqual(keys(cards("As Ah Ad Kc Kh")));
  });

  it("allows the five board cards to be the complete best hand", () => {
    const holeCards = cards("2c 3d");
    const board = cards("As Kd Qh Jc Ts");
    const result = evaluateBestHand([...holeCards, ...board]);
    expect(keys(result.bestFive)).toEqual(keys(board));
  });

  it("uses a canonical best five when equal-rank alternatives exist", () => {
    const result = evaluateBestHand(cards("As Ah Kd Qc Jh Ts 2d"));
    expect(result.bestFive.some((card) => cardKey(card) === cardKey(cards("As")[0]!))).toBe(true);
    expect(result.bestFive.some((card) => cardKey(card) === cardKey(cards("Ah")[0]!))).toBe(false);
  });

  it("returns immutable normalized output", () => {
    const result = evaluateBestHand(cards("As Ah Ad Kc Kh 2s 3d"));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tiebreakers)).toBe(true);
    expect(Object.isFrozen(result.bestFive)).toBe(true);
  });
});

describe("input validation", () => {
  it("rejects duplicate cards", () => {
    expect(() => evaluateBestHand(cards("As As Kd Qc Jh"))).toThrow(/duplicate/u);
  });

  it("rejects fewer than five cards", () => {
    expect(() => evaluateBestHand(cards("As Kd Qc Jh"))).toThrow(RangeError);
  });

  it("rejects more than seven cards", () => {
    expect(() => evaluateBestHand(cards("As Kd Qc Jh Ts 9d 8c 7h"))).toThrow(RangeError);
  });

  it.each([
    { rank: 15, suit: "s" },
    { rank: 14, suit: "x" },
    { rank: 2.5, suit: "c" },
  ])("rejects an invalid runtime card %#", (invalidCard) => {
    const supplied = [...cards("As Kd Qc Jh"), invalidCard] as unknown as readonly Card[];
    expect(() => evaluateBestHand(supplied)).toThrow(/invalid card/u);
  });
});
