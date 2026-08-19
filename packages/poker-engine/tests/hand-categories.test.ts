import { describe, expect, it } from "vitest";

import { compareHandRanks, evaluateBestHand, HandCategory } from "../src/index.js";
import { cards } from "./helpers.js";

const CATEGORY_CASES = [
  [HandCategory.HighCard, "As Kd 9c 7h 3s"],
  [HandCategory.OnePair, "As Ad Kc 7h 3s"],
  [HandCategory.TwoPair, "As Ad Kc Kh 3s"],
  [HandCategory.ThreeOfAKind, "As Ad Ac 7h 3s"],
  [HandCategory.Straight, "9s 8d 7c 6h 5s"],
  [HandCategory.Flush, "As Js 8s 5s 2s"],
  [HandCategory.FullHouse, "As Ad Ac Kh Ks"],
  [HandCategory.FourOfAKind, "As Ad Ac Ah Ks"],
  [HandCategory.StraightFlush, "9s 8s 7s 6s 5s"],
] as const;

describe("standard hand categories", () => {
  it.each(CATEGORY_CASES)("recognizes category %s", (category, notation) => {
    expect(evaluateBestHand(cards(notation)).category).toBe(category);
  });

  it("orders all nine categories strictly", () => {
    const ranks = CATEGORY_CASES.map(([, notation]) => evaluateBestHand(cards(notation)));
    for (let index = 1; index < ranks.length; index += 1) {
      expect(compareHandRanks(ranks[index]!, ranks[index - 1]!)).toBe(1);
      expect(compareHandRanks(ranks[index - 1]!, ranks[index]!)).toBe(-1);
    }
  });

  it("recognizes A2345 as the five-high wheel straight", () => {
    const result = evaluateBestHand(cards("As 2d 3c 4h 5s"));
    expect(result.category).toBe(HandCategory.Straight);
    expect(result.tiebreakers).toEqual([5]);
  });

  it.each(["As Kd Qc 3h 2s", "As Kd 4c 3h 2s"])(
    "rejects wraparound sequence %s as a straight",
    (notation) => {
      expect(evaluateBestHand(cards(notation)).category).toBe(HandCategory.HighCard);
    },
  );
});
