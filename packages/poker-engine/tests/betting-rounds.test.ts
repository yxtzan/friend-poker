import { describe, expect, it } from "vitest";

import {
  BettingStatus,
  legalActions,
  PlayerActionType,
  Street,
} from "../src/index.js";
import {
  act,
  advanceToFlop,
  player,
  startHand,
} from "./betting-helpers.js";

describe("betting-round completion", () => {
  it("advances after everyone checks", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Check);
    state = act(state, PlayerActionType.Check);
    expect(state.street).toBe(Street.Flop);
    state = act(state, PlayerActionType.Check);
    expect(state.street).toBe(Street.Turn);
    expect(state.currentActorId).toBe("A");
  });

  it("advances after a Bet and all required Calls", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 6);
    state = act(state, PlayerActionType.Call);
    expect(state.street).toBe(Street.Flop);
    state = act(state, PlayerActionType.Call);
    expect(state.street).toBe(Street.Turn);
  });

  it("ends uncontested after a Bet and all opponents Fold", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 6);
    state = act(state, PlayerActionType.Fold);
    state = act(state, PlayerActionType.Fold);
    expect(state.status).toBe(BettingStatus.Uncontested);
    expect(state.uncontestedWinnerId).toBe("A");
    expect(state.currentActorId).toBeNull();
  });

  it("advances after a Raise and all required Calls", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 5);
    state = act(state, PlayerActionType.Raise, 12);
    state = act(state, PlayerActionType.Call);
    state = act(state, PlayerActionType.Call);
    expect(state.street).toBe(Street.Turn);
  });

  it("continues correctly through several Raises", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 2);
    state = act(state, PlayerActionType.Raise, 4);
    state = act(state, PlayerActionType.Raise, 8);
    state = act(state, PlayerActionType.Raise, 12);
    state = act(state, PlayerActionType.Call);
    state = act(state, PlayerActionType.Call);
    expect(state.street).toBe(Street.Turn);
  });

  it("does not complete while a matched blind still has its action pending", () => {
    let state = startHand([100, 100, 100], { buttonSeat: 0 });
    state = act(state, PlayerActionType.Call); // A
    state = act(state, PlayerActionType.Call); // B
    expect(state.street).toBe(Street.Preflop);
    expect(state.currentActorId).toBe("C");
    expect(legalActions(state).canCheck).toBe(true);
  });

  it("skips Folded and All-in players when finding the next actor", () => {
    let state = advanceToFlop([100, 3, 100, 100], { buttonSeat: 3 });
    state = act(state, PlayerActionType.Bet, 3); // A
    state = act(state, PlayerActionType.AllIn); // B calls all-in
    state = act(state, PlayerActionType.Fold); // C
    expect(state.currentActorId).toBe("D");
    expect(player(state, "B").allIn).toBe(true);
    expect(player(state, "C").folded).toBe(true);
  });

  it("requests runout when all remaining contenders are All-in", () => {
    let state = advanceToFlop([10, 10], { buttonSeat: 0 });
    state = act(state, PlayerActionType.AllIn);
    state = act(state, PlayerActionType.Call);
    expect(state.status).toBe(BettingStatus.RunoutRequired);
    expect(state.currentActorId).toBeNull();
  });

  it("resets street contributions but preserves total hand contributions", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    const totalsBefore = state.participants.map((participant) => participant.totalContribution);
    state = act(state, PlayerActionType.Bet, 5);
    state = act(state, PlayerActionType.Call);
    state = act(state, PlayerActionType.Call);

    expect(state.street).toBe(Street.Turn);
    expect(state.participants.every((participant) => participant.streetContribution === 0)).toBe(true);
    expect(state.participants.map((participant) => participant.totalContribution)).toEqual(
      totalsBefore.map((total) => total + 5),
    );
    expect(state.currentBet).toBe(0);
    expect(state.lastFullRaiseIncrement).toBe(2);
  });

  it("enters showdown-pending after River betting completes", () => {
    let state = advanceToFlop([100, 100], { buttonSeat: 0 });
    for (const expectedStreet of [Street.Turn, Street.River]) {
      state = act(state, PlayerActionType.Check);
      state = act(state, PlayerActionType.Check);
      expect(state.street).toBe(expectedStreet);
    }
    state = act(state, PlayerActionType.Check);
    state = act(state, PlayerActionType.Check);
    expect(state.status).toBe(BettingStatus.ShowdownPending);
    expect(state.currentActorId).toBeNull();
  });
});

describe("heads-up order", () => {
  it("has Button/SB act first preflop and BB first postflop", () => {
    let state = startHand([100, 100], { buttonSeat: 0 });
    expect(state.currentActorId).toBe("A");
    expect(state.smallBlindSeat).toBe(0);
    expect(state.bigBlindSeat).toBe(1);
    state = act(state, PlayerActionType.Call);
    state = act(state, PlayerActionType.Check);
    expect(state.street).toBe(Street.Flop);
    expect(state.currentActorId).toBe("B");
  });

  it("continues action correctly after a postflop Raise", () => {
    let state = advanceToFlop([100, 100], { buttonSeat: 0 });
    expect(state.currentActorId).toBe("B");
    state = act(state, PlayerActionType.Bet, 5);
    state = act(state, PlayerActionType.Raise, 10);
    expect(state.currentActorId).toBe("B");
    expect(legalActions(state)).toMatchObject({ callAmount: 5, canRaise: true });
    state = act(state, PlayerActionType.Call);
    expect(state.street).toBe(Street.Turn);
    expect(state.currentActorId).toBe("B");
  });

  it("requests runout after one player goes All-in and the other Calls", () => {
    let state = startHand([10, 100], { buttonSeat: 0 });
    state = act(state, PlayerActionType.AllIn);
    expect(state.currentActorId).toBe("B");
    state = act(state, PlayerActionType.Call);
    expect(state.status).toBe(BettingStatus.RunoutRequired);
  });
});
