import { describe, expect, it } from "vitest";

import {
  ActionSemantic,
  legalActions,
  PlayerActionType,
} from "../src/index.js";
import { act, advanceToFlop, player, startHand } from "./betting-helpers.js";

describe("minimum full Bet and Raise", () => {
  it("uses Raise-to 10 after a preflop Raise-to 6 over a 2 BB", () => {
    let state = startHand([100, 100, 100], { buttonSeat: 0 });
    state = act(state, PlayerActionType.Raise, 6);
    expect(legalActions(state).minimumRaiseTo).toBe(10);
  });

  it("uses Raise-to 19 after Bet 5 and Raise-to 12", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 5);
    state = act(state, PlayerActionType.Raise, 12);
    expect(state.lastFullRaiseIncrement).toBe(7);
    expect(legalActions(state).minimumRaiseTo).toBe(19);
  });

  it("updates the minimum increment after each full Raise", () => {
    let state = startHand([100, 100, 100, 100], { buttonSeat: 0 });
    state = act(state, PlayerActionType.Raise, 6);
    state = act(state, PlayerActionType.Raise, 12);
    expect(state.lastFullRaiseIncrement).toBe(6);
    expect(legalActions(state).minimumRaiseTo).toBe(18);
  });

  it("does not reset the full increment after a short All-in Raise", () => {
    let state = advanceToFlop([100, 15, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 10);
    state = act(state, PlayerActionType.AllIn);
    expect(state.currentBet).toBe(15);
    expect(state.lastFullRaiseIncrement).toBe(10);
    expect(state.lastAction).toMatchObject({
      semantic: ActionSemantic.Raise,
      isAllIn: true,
      isFullBetOrRaise: false,
    });
    expect(legalActions(state).minimumRaiseTo).toBe(25);
  });

  it("requires a full minimum increment on top of a short opening All-in Bet", () => {
    let state = advanceToFlop([1, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.AllIn);
    expect(state.currentBet).toBe(1);
    expect(state.lastFullRaiseIncrement).toBe(2);
    expect(state.lastAction).toMatchObject({
      semantic: ActionSemantic.Bet,
      isFullBetOrRaise: false,
    });
    expect(legalActions(state).minimumRaiseTo).toBe(3);
  });
});

describe("short All-in reopening", () => {
  it("keeps a prior check-raise available when a full Bet was followed by a short All-in", () => {
    let state = advanceToFlop([100, 100, 15, 100], { buttonSeat: 3 });
    state = act(state, PlayerActionType.Check); // A at level 0
    state = act(state, PlayerActionType.Bet, 10); // B full Bet
    state = act(state, PlayerActionType.AllIn); // C short raise to 15
    state = act(state, PlayerActionType.Call); // D

    expect(state.currentActorId).toBe("A");
    expect(player(state, "A")).toMatchObject({ lastActionBetLevel: 0, raiseRightsOpen: true });
    expect(legalActions(state)).toMatchObject({ canRaise: true, minimumRaiseTo: 25 });
  });

  it("does not reopen A or B after A bets 10, B calls, and C goes All-in to 15", () => {
    let state = advanceToFlop([100, 100, 15], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 10); // A
    state = act(state, PlayerActionType.Call); // B
    state = act(state, PlayerActionType.AllIn); // C to 15

    expect(state.currentActorId).toBe("A");
    expect(player(state, "A")).toMatchObject({ lastActionBetLevel: 10, raiseRightsOpen: false });
    expect(player(state, "B")).toMatchObject({ lastActionBetLevel: 10, raiseRightsOpen: false });
    expect(legalActions(state)).toMatchObject({
      canCall: true,
      callAmount: 5,
      canRaise: false,
      raiseRightsOpen: false,
    });

    state = act(state, PlayerActionType.Call);
    expect(state.currentActorId).toBe("B");
    expect(legalActions(state).canRaise).toBe(false);
  });

  it("reopens after cumulative short All-ins reach one full increment", () => {
    let state = advanceToFlop([100, 15, 20, 100], { buttonSeat: 3 });
    state = act(state, PlayerActionType.Bet, 10); // A
    state = act(state, PlayerActionType.AllIn); // B to 15
    state = act(state, PlayerActionType.AllIn); // C to 20
    state = act(state, PlayerActionType.Call); // D calls 20

    expect(state.currentActorId).toBe("A");
    expect(player(state, "A")).toMatchObject({ lastActionBetLevel: 10, raiseRightsOpen: true });
    expect(legalActions(state)).toMatchObject({
      canCall: true,
      callAmount: 10,
      canRaise: true,
      minimumRaiseTo: 30,
    });
  });

  it("reopens after cumulative short opening All-ins reach one big blind", () => {
    let state = advanceToFlop([100, 1, 2, 100], { buttonSeat: 3 });
    state = act(state, PlayerActionType.Check); // A at 0
    state = act(state, PlayerActionType.AllIn); // B opens to 1
    state = act(state, PlayerActionType.AllIn); // C increases to 2
    state = act(state, PlayerActionType.Call); // D calls 2

    expect(state.currentActorId).toBe("A");
    expect(state.lastFullRaiseIncrement).toBe(2);
    expect(player(state, "A").raiseRightsOpen).toBe(true);
    expect(legalActions(state)).toMatchObject({ canRaise: true, minimumRaiseTo: 4 });
  });

  it("tracks reopening separately for each player", () => {
    let state = advanceToFlop([100, 15, 100, 20], { buttonSeat: 3 });
    state = act(state, PlayerActionType.Bet, 10); // A last faced 10
    state = act(state, PlayerActionType.AllIn); // B to 15
    state = act(state, PlayerActionType.Call); // C last faced 15
    state = act(state, PlayerActionType.AllIn); // D to 20

    expect(player(state, "A").raiseRightsOpen).toBe(true);
    expect(player(state, "C").raiseRightsOpen).toBe(false);
    expect(legalActions(state).canRaise).toBe(true);

    state = act(state, PlayerActionType.Call); // A
    expect(state.currentActorId).toBe("C");
    expect(legalActions(state)).toMatchObject({
      callAmount: 5,
      canRaise: false,
      raiseRightsOpen: false,
    });
  });
});
