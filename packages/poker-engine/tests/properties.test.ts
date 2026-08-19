import { describe, expect, it } from "vitest";

import { compareHandRanks, evaluateBestHand } from "../src/index.js";
import { cardKey, randomHand, seededRandom, shuffled } from "./helpers.js";

const PROPERTY_SEED = 0x5eed1234;

describe(`deterministic property checks (seed ${PROPERTY_SEED})`, () => {
  it("is invariant to input order and chooses only supplied unique cards", () => {
    const rng = seededRandom(PROPERTY_SEED);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const supplied = randomHand(7, rng);
      const baseline = evaluateBestHand(supplied);
      const reordered = evaluateBestHand(shuffled(supplied, rng));

      expect(compareHandRanks(baseline, reordered)).toBe(0);
      expect(reordered.bestFive.map(cardKey)).toEqual(baseline.bestFive.map(cardKey));

      const suppliedKeys = new Set(supplied.map(cardKey));
      const selectedKeys = reordered.bestFive.map(cardKey);
      expect(selectedKeys).toHaveLength(5);
      expect(new Set(selectedKeys)).toHaveLength(5);
      expect(selectedKeys.every((key) => suppliedKeys.has(key))).toBe(true);
    }
  });

  it("comparison is antisymmetric", () => {
    const rng = seededRandom(PROPERTY_SEED ^ 0x11111111);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const left = evaluateBestHand(randomHand(7, rng));
      const right = evaluateBestHand(randomHand(7, rng));
      expect(compareHandRanks(left, right) + compareHandRanks(right, left)).toBe(0);
    }
  });

  it("comparison is transitive", () => {
    const rng = seededRandom(PROPERTY_SEED ^ 0x22222222);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const ranks = [
        evaluateBestHand(randomHand(7, rng)),
        evaluateBestHand(randomHand(7, rng)),
        evaluateBestHand(randomHand(7, rng)),
      ].sort((left, right) => compareHandRanks(right, left));

      expect(compareHandRanks(ranks[0]!, ranks[1]!)).toBeGreaterThanOrEqual(0);
      expect(compareHandRanks(ranks[1]!, ranks[2]!)).toBeGreaterThanOrEqual(0);
      expect(compareHandRanks(ranks[0]!, ranks[2]!)).toBeGreaterThanOrEqual(0);
    }
  });
});
