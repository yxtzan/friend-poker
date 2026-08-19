import { expect, it } from "vitest";

import { createDeck, evaluateBestHand, HandCategory } from "../src/index.js";

it("classifies all 2,598,960 distinct five-card combinations", () => {
  const deck = createDeck();
  const counts = Array<number>(9).fill(0);
  let combinations = 0;

  for (let first = 0; first < deck.length - 4; first += 1) {
    for (let second = first + 1; second < deck.length - 3; second += 1) {
      for (let third = second + 1; third < deck.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < deck.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < deck.length; fifth += 1) {
            const result = evaluateBestHand([
              deck[first]!,
              deck[second]!,
              deck[third]!,
              deck[fourth]!,
              deck[fifth]!,
            ]);
            counts[result.category] = counts[result.category]! + 1;
            combinations += 1;
          }
        }
      }
    }
  }

  expect(combinations).toBe(2_598_960);
  expect(counts[HandCategory.HighCard]).toBe(1_302_540);
  expect(counts[HandCategory.OnePair]).toBe(1_098_240);
  expect(counts[HandCategory.TwoPair]).toBe(123_552);
  expect(counts[HandCategory.ThreeOfAKind]).toBe(54_912);
  expect(counts[HandCategory.Straight]).toBe(10_200);
  expect(counts[HandCategory.Flush]).toBe(5_108);
  expect(counts[HandCategory.FullHouse]).toBe(3_744);
  expect(counts[HandCategory.FourOfAKind]).toBe(624);
  expect(counts[HandCategory.StraightFlush]).toBe(40);
});
