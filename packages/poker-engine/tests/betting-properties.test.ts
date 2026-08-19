import { describe, expect, it } from "vitest";

import {
  applyAction,
  BettingStatus,
  createBettingState,
  legalActions,
  PlayerActionType,
} from "../src/index.js";
import type {
  BettingCommand,
  BettingState,
  LegalActions,
  StartBettingHandInput,
} from "../src/index.js";
import { assertChipInvariant, participantInputs } from "./betting-helpers.js";
import { seededRandom } from "./helpers.js";

const BETTING_PROPERTY_SEED = 0xb3771a6;

function chooseCommand(state: BettingState, legal: LegalActions, random: () => number): BettingCommand {
  const choices: BettingCommand[] = [];
  const playerId = legal.playerId;
  choices.push({ playerId, type: PlayerActionType.Fold });
  if (legal.canCheck) choices.push({ playerId, type: PlayerActionType.Check });
  if (legal.canCall) choices.push({ playerId, type: PlayerActionType.Call });
  if (legal.canBet && legal.minimumBet !== null) {
    choices.push({ playerId, type: PlayerActionType.Bet, amount: legal.minimumBet });
  }
  if (legal.canRaise && legal.minimumRaiseTo !== null) {
    choices.push({ playerId, type: PlayerActionType.Raise, raiseTo: legal.minimumRaiseTo });
  }
  if (legal.canAllIn) choices.push({ playerId, type: PlayerActionType.AllIn });

  const choice = choices[Math.floor(random() * choices.length)];
  if (choice === undefined) {
    throw new Error(`No generated command for ${state.currentActorId ?? "no actor"}`);
  }
  return choice;
}

function assertStateInvariants(state: BettingState): void {
  assertChipInvariant(state);
  expect(state.participants.every((participant) => Number.isInteger(participant.stack))).toBe(true);
  expect(state.participants.every((participant) => Number.isInteger(participant.totalContribution))).toBe(true);
  expect(state.participants.every((participant) => Number.isInteger(participant.streetContribution))).toBe(true);

  if (state.status === BettingStatus.Betting) {
    expect(state.currentActorId).not.toBeNull();
    const actor = state.participants.find(
      (participant) => participant.playerId === state.currentActorId,
    );
    expect(actor).toBeDefined();
    expect(actor?.folded).toBe(false);
    expect(actor?.allIn).toBe(false);
    const legal = legalActions(state);
    expect(legal.canFold).toBe(true);
    expect(legal.canCheck || legal.canCall).toBe(true);
  } else {
    expect(state.currentActorId).toBeNull();
  }
}

describe(`deterministic betting properties (seed ${BETTING_PROPERTY_SEED})`, () => {
  it("preserves chip and actionability invariants across randomized hands", () => {
    const random = seededRandom(BETTING_PROPERTY_SEED);

    for (let hand = 0; hand < 250; hand += 1) {
      const playerCount = 2 + Math.floor(random() * 5);
      const stacks = Array.from(
        { length: playerCount },
        () => 1 + Math.floor(random() * 60),
      );
      let state = createBettingState({
        participants: participantInputs(stacks),
        buttonSeat: Math.floor(random() * playerCount),
        smallBlind: 1,
        bigBlind: 2,
      });
      assertStateInvariants(state);

      for (let step = 0; step < 200 && state.status === BettingStatus.Betting; step += 1) {
        const command = chooseCommand(state, legalActions(state), random);
        const before = JSON.stringify(state);
        state = applyAction(state, command);
        expect(JSON.stringify(state)).not.toBe(before);
        assertStateInvariants(state);
      }
      expect(state.status).not.toBe(BettingStatus.Betting);
    }
  });

  it("replays the same action list to the identical state", () => {
    const random = seededRandom(BETTING_PROPERTY_SEED ^ 0x51515151);

    for (let hand = 0; hand < 100; hand += 1) {
      const playerCount = 2 + Math.floor(random() * 5);
      const input: StartBettingHandInput = {
        participants: participantInputs(
          Array.from({ length: playerCount }, () => 5 + Math.floor(random() * 50)),
        ),
        buttonSeat: Math.floor(random() * playerCount),
        smallBlind: 1,
        bigBlind: 2,
      };
      const commands: BettingCommand[] = [];
      let original = createBettingState(input);

      while (original.status === BettingStatus.Betting && commands.length < 200) {
        const command = chooseCommand(original, legalActions(original), random);
        commands.push(command);
        original = applyAction(original, command);
      }

      let replay = createBettingState(input);
      for (const command of commands) {
        replay = applyAction(replay, command);
      }
      expect(replay).toEqual(original);
    }
  });
});
