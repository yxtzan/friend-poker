import { describe, expect, it } from "vitest";

import {
  ActionSemantic,
  applyAction,
  BettingRuleError,
  legalActions,
  PlayerActionType,
} from "../src/index.js";
import { act, advanceToFlop, player, startHand } from "./betting-helpers.js";

describe("basic legal actions", () => {
  it("allows Check when no Bet exists", () => {
    const state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    const legal = legalActions(state);
    expect(legal.playerId).toBe("A");
    expect(legal.canCheck).toBe(true);
    expect(legal.canCall).toBe(false);
    expect(legal.canBet).toBe(true);
    expect(legal.minimumBet).toBe(2);
  });

  it("rejects Check while facing a Bet", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 5);
    expect(legalActions(state)).toMatchObject({ canCheck: false, canCall: true, callAmount: 5 });
    expect(() =>
      applyAction(state, { playerId: state.currentActorId!, type: PlayerActionType.Check }),
    ).toThrow(BettingRuleError);
  });

  it("calls the exact amount without committing twice", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 7);
    const before = player(state, "B");
    state = act(state, PlayerActionType.Call);
    expect(player(state, "B")).toMatchObject({
      stack: before.stack - 7,
      streetContribution: 7,
      totalContribution: before.totalContribution + 7,
    });
    expect(state.lastAction).toMatchObject({ semantic: ActionSemantic.Call, amountCommitted: 7 });
  });

  it("makes an all-in Call when the stack cannot cover the Bet", () => {
    let state = advanceToFlop([100, 4, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 10);
    expect(legalActions(state)).toMatchObject({
      playerId: "B",
      canCall: true,
      callAmount: 4,
      callIsAllIn: true,
    });
    state = act(state, PlayerActionType.Call);
    expect(player(state, "B")).toMatchObject({
      stack: 0,
      streetContribution: 4,
      allIn: true,
    });
    expect(state.lastAction).toMatchObject({ semantic: ActionSemantic.Call, isAllIn: true });
  });

  it("records an explicit All-in command as a semantic Call when facing more than its stack", () => {
    let state = advanceToFlop([100, 4, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 10);
    state = act(state, PlayerActionType.AllIn);
    expect(state.lastAction).toMatchObject({
      requestedType: PlayerActionType.AllIn,
      semantic: ActionSemantic.Call,
      amountCommitted: 4,
      isAllIn: true,
      isFullBetOrRaise: false,
    });
  });

  it("folds and never selects the folded player again", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Fold);
    expect(player(state, "A").folded).toBe(true);
    expect(state.currentActorId).toBe("B");
  });

  it("makes a legal opening Bet", () => {
    let state = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    state = act(state, PlayerActionType.Bet, 5);
    expect(state.currentBet).toBe(5);
    expect(state.lastFullRaiseIncrement).toBe(5);
    expect(player(state, "A").streetContribution).toBe(5);
    expect(state.lastAction).toMatchObject({
      semantic: ActionSemantic.Bet,
      isFullBetOrRaise: true,
    });
  });

  it("makes a legal full Raise using Raise-to semantics", () => {
    let state = startHand([100, 100, 100], { buttonSeat: 0 });
    state = act(state, PlayerActionType.Raise, 6);
    expect(state.currentBet).toBe(6);
    expect(state.lastFullRaiseIncrement).toBe(4);
    expect(player(state, "A").streetContribution).toBe(6);
    expect(state.lastAction?.semantic).toBe(ActionSemantic.Raise);
  });

  it("rejects a too-small Raise", () => {
    const state = startHand([100, 100, 100], { buttonSeat: 0 });
    expect(legalActions(state).minimumRaiseTo).toBe(4);
    expect(() => act(state, PlayerActionType.Raise, 3)).toThrow(/Minimum Raise-to/u);
  });

  it("rejects a Raise above the available stack", () => {
    const state = startHand([10, 100, 100], { buttonSeat: 0 });
    expect(() => act(state, PlayerActionType.Raise, 11)).toThrow(/exceeds/u);
  });

  it("rejects an opening Bet above the available stack", () => {
    const state = advanceToFlop([4, 100, 100], { buttonSeat: 2 });
    expect(() => act(state, PlayerActionType.Bet, 5)).toThrow(/exceeds/u);
  });

  it("supports an All-in for the complete available stack", () => {
    let state = startHand([10, 100, 100], { buttonSeat: 0 });
    state = act(state, PlayerActionType.AllIn);
    expect(player(state, "A")).toMatchObject({
      stack: 0,
      streetContribution: 10,
      totalContribution: 10,
      allIn: true,
    });
    expect(state.lastAction).toMatchObject({
      requestedType: PlayerActionType.AllIn,
      semantic: ActionSemantic.Raise,
      isAllIn: true,
      isFullBetOrRaise: true,
    });
  });

  it("rejects fractional and negative Bet/Raise values", () => {
    const flop = advanceToFlop([100, 100, 100], { buttonSeat: 2 });
    expect(() => act(flop, PlayerActionType.Bet, 2.5)).toThrow(/positive integer/u);
    expect(() => act(flop, PlayerActionType.Bet, -2)).toThrow(/positive integer/u);

    const preflop = startHand([100, 100, 100], { buttonSeat: 0 });
    expect(() => act(preflop, PlayerActionType.Raise, 4.5)).toThrow(/positive integer/u);
  });

  it("rejects an out-of-turn action without mutating state", () => {
    const state = startHand([100, 100, 100], { buttonSeat: 0 });
    const before = JSON.stringify(state);
    expect(() =>
      applyAction(state, { playerId: "B", type: PlayerActionType.Call }),
    ).toThrow(/not B's turn/u);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("does not mutate the caller-owned state during a valid transition", () => {
    const state = startHand([100, 100, 100], { buttonSeat: 0 });
    const before = JSON.stringify(state);
    const next = act(state, PlayerActionType.Call);
    expect(JSON.stringify(state)).toBe(before);
    expect(next).not.toBe(state);
    expect(Object.isFrozen(next)).toBe(true);
    expect(next.participants.every(Object.isFrozen)).toBe(true);
  });
});
