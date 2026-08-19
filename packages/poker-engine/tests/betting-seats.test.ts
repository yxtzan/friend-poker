import { describe, expect, it } from "vitest";

import {
  determineBlindPositions,
  moveButton,
  nextEligibleSeat,
} from "../src/index.js";

describe("seat and blind position helpers", () => {
  it("uses the Button as SB heads-up", () => {
    expect(determineBlindPositions(0, [0, 1])).toEqual({
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      firstPreflopSeat: 0,
      firstPostflopSeat: 1,
    });
  });

  it("places blinds and action correctly for three players", () => {
    expect(determineBlindPositions(0, [0, 1, 2])).toEqual({
      buttonSeat: 0,
      smallBlindSeat: 1,
      bigBlindSeat: 2,
      firstPreflopSeat: 0,
      firstPostflopSeat: 1,
    });
  });

  it("wraps positions correctly for six players", () => {
    expect(determineBlindPositions(4, [0, 1, 2, 3, 4, 5])).toEqual({
      buttonSeat: 4,
      smallBlindSeat: 5,
      bigBlindSeat: 0,
      firstPreflopSeat: 1,
      firstPostflopSeat: 5,
    });
  });

  it("supports gaps in participant seat numbers", () => {
    expect(determineBlindPositions(4, [1, 4, 9])).toEqual({
      buttonSeat: 4,
      smallBlindSeat: 9,
      bigBlindSeat: 1,
      firstPreflopSeat: 4,
      firstPostflopSeat: 9,
    });
    expect(nextEligibleSeat(4, [1, 9])).toBe(9);
    expect(nextEligibleSeat(9, [1, 4])).toBe(1);
  });

  it("moves the Button while skipping absent players", () => {
    expect(moveButton(1, [0, 3, 5])).toBe(3);
    expect(moveButton(3, [0, 3, 5])).toBe(5);
    expect(moveButton(5, [0, 3, 5])).toBe(0);
  });

  it.each([
    () => determineBlindPositions(0, [0]),
    () => determineBlindPositions(2, [0, 1]),
    () => nextEligibleSeat(-1, [0]),
    () => moveButton(0, [1, 1]),
  ])("rejects invalid seat configurations", (operation) => {
    expect(operation).toThrow(RangeError);
  });
});
