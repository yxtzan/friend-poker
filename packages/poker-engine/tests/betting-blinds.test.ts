import { describe, expect, it } from "vitest";

import { BettingStatus, createBettingState } from "../src/index.js";
import { player, startHand } from "./betting-helpers.js";

describe("blind posting", () => {
  it("posts normal 1/2 blinds into preflop and starts after the BB", () => {
    const state = startHand([100, 100, 100], { buttonSeat: 0 });
    expect(state.smallBlindSeat).toBe(1);
    expect(state.bigBlindSeat).toBe(2);
    expect(player(state, "B")).toMatchObject({
      stack: 99,
      streetContribution: 1,
      totalContribution: 1,
    });
    expect(player(state, "C")).toMatchObject({
      stack: 98,
      streetContribution: 2,
      totalContribution: 2,
    });
    expect(state.currentActorId).toBe("A");
    expect(state.currentBet).toBe(2);
  });

  it("posts a partial SB all-in", () => {
    const state = startHand([100, 1, 100], { buttonSeat: 0 });
    expect(player(state, "B")).toMatchObject({
      stack: 0,
      streetContribution: 1,
      allIn: true,
    });
    expect(state.currentActorId).toBe("A");
  });

  it("posts a partial BB all-in while retaining the nominal BB call level", () => {
    const state = startHand([100, 100, 1], { buttonSeat: 0 });
    expect(player(state, "C")).toMatchObject({
      stack: 0,
      streetContribution: 1,
      allIn: true,
    });
    expect(state.currentBet).toBe(2);
    expect(state.lastFullRaiseIncrement).toBe(2);
    expect(state.currentActorId).toBe("A");
  });

  it("handles unusual heads-up stacks where both blinds are all-in", () => {
    const state = startHand([1, 1], { buttonSeat: 0 });
    expect(player(state, "A").streetContribution).toBe(1);
    expect(player(state, "B").streetContribution).toBe(1);
    expect(state.currentBet).toBe(2);
    expect(state.status).toBe(BettingStatus.RunoutRequired);
    expect(state.currentActorId).toBeNull();
  });

  it("ends betting when only the BB can still act and no opponent can respond", () => {
    const state = startHand([1, 100], { buttonSeat: 0 });
    expect(state.status).toBe(BettingStatus.RunoutRequired);
    expect(state.currentActorId).toBeNull();
  });
});

describe("hand-start validation", () => {
  it.each([
    { participants: [{ playerId: "A", seat: 0, stack: 10 }], buttonSeat: 0, smallBlind: 1, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: 0, stack: 10 }, { playerId: "B", seat: 1, stack: 0 }], buttonSeat: 0, smallBlind: 1, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: 0, stack: 10.5 }, { playerId: "B", seat: 1, stack: 10 }], buttonSeat: 0, smallBlind: 1, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: -1, stack: 10 }, { playerId: "B", seat: 1, stack: 10 }], buttonSeat: 1, smallBlind: 1, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: 0, stack: 10 }, { playerId: "A", seat: 1, stack: 10 }], buttonSeat: 0, smallBlind: 1, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: 0, stack: 10 }, { playerId: "B", seat: 0, stack: 10 }], buttonSeat: 0, smallBlind: 1, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: 0, stack: 10 }, { playerId: "B", seat: 1, stack: 10 }], buttonSeat: 0, smallBlind: 0.5, bigBlind: 2 },
    { participants: [{ playerId: "A", seat: 0, stack: 10 }, { playerId: "B", seat: 1, stack: 10 }], buttonSeat: 0, smallBlind: 3, bigBlind: 2 },
  ])("rejects excluded or invalid participant inputs", (input) => {
    expect(() => createBettingState(input)).toThrow(RangeError);
  });
});
