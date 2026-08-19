import { describe, expect, it } from "vitest";

import {
  getHandRecord,
  HandLifecycleStatus,
  PlayerActionType,
  Street,
} from "../src/index.js";
import {
  actHand,
  assertCardAccounting,
  callOrCheck,
  startOrchestratedHand,
} from "./hand-helpers.js";

function completeCurrentStreet(state: ReturnType<typeof startOrchestratedHand>) {
  const street = state.bettingState.street;
  let next = state;
  while (
    next.status === HandLifecycleStatus.Betting &&
    next.bettingState.street === street
  ) {
    next = callOrCheck(next);
  }
  return next;
}

describe("normal board progression", () => {
  it("reveals Flop, Turn, and River at the exact street boundaries", () => {
    let state = startOrchestratedHand([100, 100, 100], { buttonSeat: 0 });

    state = completeCurrentStreet(state);
    expect(state.bettingState.street).toBe(Street.Flop);
    expect(state.board).toHaveLength(3);
    expect(state.bettingState.currentActorId).toBe("B");
    expect(state.events.at(-1)).toMatchObject({ type: "BOARD_REVEALED", street: Street.Flop });

    state = completeCurrentStreet(state);
    expect(state.bettingState.street).toBe(Street.Turn);
    expect(state.board).toHaveLength(4);
    expect(state.events.at(-1)).toMatchObject({ type: "BOARD_REVEALED", street: Street.Turn });

    state = completeCurrentStreet(state);
    expect(state.bettingState.street).toBe(Street.River);
    expect(state.board).toHaveLength(5);
    expect(state.events.at(-1)).toMatchObject({ type: "BOARD_REVEALED", street: Street.River });

    state = completeCurrentStreet(state);
    expect(state.status).toBe(HandLifecycleStatus.Complete);
    expect(state.settlement).not.toBeNull();
    assertCardAccounting(state);
  });

  it("returns the Flop before exposing the first postflop actor heads-up", () => {
    let state = startOrchestratedHand([100, 100], { buttonSeat: 0 });
    expect(state.bettingState.currentActorId).toBe("A");
    state = actHand(state, PlayerActionType.Call);
    state = actHand(state, PlayerActionType.Check);

    expect(state.bettingState.street).toBe(Street.Flop);
    expect(state.board).toHaveLength(3);
    expect(state.bettingState.currentActorId).toBe("B");
  });

  it("preserves the betting engine's 3-player action order", () => {
    let state = startOrchestratedHand([100, 100, 100], { buttonSeat: 0 });
    expect(state.bettingState.currentActorId).toBe("A");
    state = callOrCheck(state);
    expect(state.bettingState.currentActorId).toBe("B");
    state = callOrCheck(state);
    expect(state.bettingState.currentActorId).toBe("C");
    state = callOrCheck(state);
    expect(state.bettingState.currentActorId).toBe("B");
    expect(state.board).toHaveLength(3);
  });

  it("records every action with its original street and betting-engine semantics", () => {
    let state = startOrchestratedHand([100, 100], { buttonSeat: 0 });
    state = actHand(state, PlayerActionType.Raise, 6);
    state = actHand(state, PlayerActionType.Call);
    const actions = getHandRecord(state).actions;

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      sequence: 0,
      street: Street.Preflop,
      requestedType: PlayerActionType.Raise,
      semantic: "RAISE",
      toContribution: 6,
      amountCommitted: 5,
      isFullBetOrRaise: true,
    });
    expect(actions[1]).toMatchObject({ street: Street.Preflop, semantic: "CALL" });
    expect(state.board).toHaveLength(3);
  });

  it("never mutates an earlier hand state", () => {
    const before = startOrchestratedHand([100, 100]);
    const snapshot = JSON.stringify(before);
    const after = callOrCheck(before);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after).not.toBe(before);
  });
});
