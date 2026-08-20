import { describe, expect, it } from "vitest";
import type { ViewerLegalActions } from "@friend-poker/shared";
import { calculatePotQuickTarget } from "./bet-sizing.js";

const betting: ViewerLegalActions = {
  playerId: "alice",
  canFold: true,
  canCheck: false,
  canCall: true,
  callAmount: 6,
  callIsAllIn: false,
  canBet: false,
  minimumBet: null,
  maximumBet: null,
  canRaise: true,
  minimumRaiseTo: 12,
  maximumRaiseTo: 100,
  raiseRightsOpen: true,
  canAllIn: true,
  allInTo: 100,
};

describe("calculatePotQuickTarget", () => {
  it("uses the pot after Call as the raise increment and floors integers", () => {
    expect(calculatePotQuickTarget({ actions: betting, potSize: 25, currentBet: 10, size: "HALF_POT" })).toBe(25);
  });

  it("clamps a quick bet to the server-provided legal range", () => {
    const opening: ViewerLegalActions = {
      ...betting,
      canCall: false,
      callAmount: 0,
      canBet: true,
      minimumBet: 2,
      maximumBet: 17,
      canRaise: false,
      minimumRaiseTo: null,
      maximumRaiseTo: null,
    };
    expect(calculatePotQuickTarget({ actions: opening, potSize: 1, currentBet: 0, size: "HALF_POT" })).toBe(2);
    expect(calculatePotQuickTarget({ actions: opening, potSize: 100, currentBet: 0, size: "POT" })).toBe(17);
  });
});
