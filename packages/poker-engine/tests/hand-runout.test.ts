import { describe, expect, it } from "vitest";

import {
  advanceRunout,
  applyHandAction,
  HandLifecycleStatus,
  HandOrchestrationError,
  PlayerActionType,
} from "../src/index.js";
import {
  actHand,
  assertCardAccounting,
  callOrCheck,
  startOrchestratedHand,
} from "./hand-helpers.js";

describe("explicit All-in runout", () => {
  it("advances a preflop All-in as Flop, Turn, then River plus settlement", () => {
    let state = startOrchestratedHand([10, 100], { buttonSeat: 0 });
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);

    expect(state.status).toBe(HandLifecycleStatus.RunoutRequired);
    expect(state.board).toHaveLength(0);
    expect(state.bettingState.currentActorId).toBeNull();

    state = advanceRunout(state);
    expect(state.board).toHaveLength(3);
    expect(state.settlement).toBeNull();
    state = advanceRunout(state);
    expect(state.board).toHaveLength(4);
    expect(state.settlement).toBeNull();
    state = advanceRunout(state);
    expect(state.board).toHaveLength(5);
    expect(state.status).toBe(HandLifecycleStatus.Complete);
    expect(state.settlement).not.toBeNull();
    assertCardAccounting(state);
  });

  it("requires two calls to run out from a Flop All-in", () => {
    let state = startOrchestratedHand([12, 12]);
    state = callOrCheck(state);
    state = callOrCheck(state);
    expect(state.board).toHaveLength(3);
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);
    expect(state.status).toBe(HandLifecycleStatus.RunoutRequired);

    state = advanceRunout(state);
    expect(state.board).toHaveLength(4);
    expect(state.status).toBe(HandLifecycleStatus.RunoutRequired);
    state = advanceRunout(state);
    expect(state.board).toHaveLength(5);
    expect(state.status).toBe(HandLifecycleStatus.Complete);
  });

  it("requires one call to run out from a Turn All-in", () => {
    let state = startOrchestratedHand([12, 12]);
    for (let actions = 0; actions < 4; actions += 1) state = callOrCheck(state);
    expect(state.board).toHaveLength(4);
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);
    expect(state.status).toBe(HandLifecycleStatus.RunoutRequired);
    state = advanceRunout(state);
    expect(state.board).toHaveLength(5);
    expect(state.status).toBe(HandLifecycleStatus.Complete);
  });

  it("rejects Runout while normal action is pending", () => {
    const state = startOrchestratedHand([100, 100]);
    expect(() => advanceRunout(state)).toThrow(HandOrchestrationError);
  });

  it("rejects player actions throughout Runout", () => {
    let state = startOrchestratedHand([10, 100]);
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);
    expect(() =>
      applyHandAction(state, { playerId: "A", type: PlayerActionType.Check }),
    ).toThrow(/not waiting for a player action/u);
  });

  it("settles exactly once and rejects further Runout", () => {
    let state = startOrchestratedHand([10, 100]);
    state = actHand(state, PlayerActionType.AllIn);
    state = actHand(state, PlayerActionType.Call);
    state = advanceRunout(advanceRunout(advanceRunout(state)));
    const settlement = state.settlement;
    const settledEvents = state.events.filter((event) => event.type === "HAND_SETTLED");
    expect(settledEvents).toHaveLength(1);
    expect(() => advanceRunout(state)).toThrow(/not currently required/u);
    expect(state.settlement).toBe(settlement);
  });
});
