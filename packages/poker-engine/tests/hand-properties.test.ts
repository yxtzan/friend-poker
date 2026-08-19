import { describe, expect, it } from "vitest";

import {
  applyHandAction,
  getHandRecord,
  HandLifecycleStatus,
  PlayerActionType,
} from "../src/index.js";
import { seededRandom } from "./helpers.js";
import {
  actHand,
  assertCardAccounting,
  callOrCheck,
  startOrchestratedHand,
} from "./hand-helpers.js";

const HAND_PROPERTY_SEED = 0x4a11_cafe;

describe(`deterministic hand-orchestration properties (seed ${HAND_PROPERTY_SEED})`, () => {
  it("accounts for 52 unique cards and conserves chips across 150 complete hands", () => {
    const random = seededRandom(HAND_PROPERTY_SEED);
    for (let sample = 0; sample < 150; sample += 1) {
      const playerCount = 2 + Math.floor(random() * 5);
      const stacks = Array.from(
        { length: playerCount },
        () => 5 + Math.floor(random() * 96),
      );
      const seats = Array.from({ length: playerCount }, (_, index) => index * 3 + 1);
      let state = startOrchestratedHand(stacks, {
        seats,
        buttonSeat: seats[Math.floor(random() * playerCount)]!,
        rng: seededRandom(Math.floor(random() * 0xffff_ffff)),
      });
      assertCardAccounting(state);
      while (state.status === HandLifecycleStatus.Betting) {
        state = callOrCheck(state);
        assertCardAccounting(state);
      }

      expect(state.status).toBe(HandLifecycleStatus.Complete);
      expect(state.settlement?.totalStartingStacks).toBe(
        stacks.reduce((total, stack) => total + stack, 0),
      );
      expect(state.settlement?.totalFinalStacks).toBe(
        stacks.reduce((total, stack) => total + stack, 0),
      );
    }
  });

  it("replays identical inputs and actions to exactly identical output", () => {
    const replay = () => {
      let state = startOrchestratedHand([37, 51, 83, 29], {
        handId: "replay",
        buttonSeat: 2,
        rng: seededRandom(HAND_PROPERTY_SEED),
      });
      while (state.status === HandLifecycleStatus.Betting) state = callOrCheck(state);
      return state;
    };
    expect(replay()).toEqual(replay());
  });

  it("never leaks a deterministically folded hand into public history", () => {
    for (let playerCount = 2; playerCount <= 6; playerCount += 1) {
      let state = startOrchestratedHand(
        Array.from({ length: playerCount }, () => 100),
        { rng: seededRandom(HAND_PROPERTY_SEED + playerCount) },
      );
      const foldedId = state.bettingState.currentActorId!;
      state = actHand(state, PlayerActionType.Fold);
      while (state.status === HandLifecycleStatus.Betting) state = callOrCheck(state);
      const record = getHandRecord(state);
      expect(record.revealedHoleCards.some((hand) => hand.playerId === foldedId)).toBe(false);
    }
  });

  it("rejects all actions after completion", () => {
    let state = startOrchestratedHand([100, 100]);
    state = actHand(state, PlayerActionType.Fold);
    expect(() =>
      applyHandAction(state, { playerId: "B", type: PlayerActionType.Check }),
    ).toThrow(/not waiting for a player action/u);
  });
});
