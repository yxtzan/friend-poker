import { describe, expect, it } from "vitest";

import { compareHandRanks, evaluateBestHand } from "../src/index.js";
import { cards } from "./helpers.js";

function expectStronger(stronger: string, weaker: string): void {
  const strongerRank = evaluateBestHand(cards(stronger));
  const weakerRank = evaluateBestHand(cards(weaker));
  expect(compareHandRanks(strongerRank, weakerRank)).toBe(1);
  expect(compareHandRanks(weakerRank, strongerRank)).toBe(-1);
}

describe("normalized hand comparisons", () => {
  it.each([
    ["As Kd Qc Jh 9s", "As Kd Qc Jh 8s", "high-card final kicker"],
    ["As Ad Kc Qh 9s", "Ks Kd Ac Qh 9s", "pair rank"],
    ["As Ad Kc Qh 9s", "Ah Ac Kd Qs 8h", "pair third kicker"],
    ["As Ad Kc Kh Qs", "Ks Kd Qc Qh As", "two-pair high pair"],
    ["As Ad Qc Qh 2s", "Ah Ac Jd Js Ks", "two-pair low pair"],
    ["As Ad Kc Kh Qs", "Ah Ac Kd Ks Jh", "two-pair kicker"],
    ["As Ad Ac Kh Qs", "Ks Kd Kc Ah Qs", "trips rank"],
    ["As Ad Ac Kh Qs", "Ah Ac As Kd Jh", "trips second kicker"],
    ["Ts 9d 8c 7h 6s", "9s 8d 7c 6h 5s", "straight high card"],
    ["As Js 9s 5s 3s", "Ah Jh 8h 7h 6h", "flush middle kicker"],
    ["As Ad Ac Kh Ks", "Ks Kd Kc Ah As", "full-house trips"],
    ["As Ad Ac Kh Ks", "Ah Ac As Qh Qs", "full-house pair"],
    ["As Ad Ac Ah Ks", "Ks Kd Kc Kh As", "quads rank"],
    ["As Ad Ac Ah Ks", "Ah Ac As Ad Qs", "quads kicker"],
    ["Ts 9s 8s 7s 6s", "9h 8h 7h 6h 5h", "straight-flush high card"],
  ])("uses %s over %s for %s", (stronger, weaker) => {
    expectStronger(stronger, weaker);
  });

  it("treats exact poker strength as a tie", () => {
    const left = evaluateBestHand(cards("As Kd Qc Jh 9s"));
    const right = evaluateBestHand(cards("Ah Ks Qd Jc 9h"));
    expect(compareHandRanks(left, right)).toBe(0);
  });

  it("never uses suits to break otherwise exact ties", () => {
    const spadeFlush = evaluateBestHand(cards("As Js 9s 5s 3s"));
    const heartFlush = evaluateBestHand(cards("Ah Jh 9h 5h 3h"));
    expect(compareHandRanks(spadeFlush, heartFlush)).toBe(0);
  });
});
