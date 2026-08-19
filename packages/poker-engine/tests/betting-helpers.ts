import {
  applyAction,
  BettingStatus,
  createBettingState,
  legalActions,
  PlayerActionType,
  Street,
} from "../src/index.js";
import type {
  BettingCommand,
  BettingState,
  HandParticipant,
  HandParticipantInput,
  Seat,
} from "../src/index.js";

const PLAYER_IDS = ["A", "B", "C", "D", "E", "F"] as const;

export function participantInputs(
  stacks: readonly number[],
  seats: readonly Seat[] = stacks.map((_, index) => index),
): readonly HandParticipantInput[] {
  return stacks.map((stack, index) => ({
    playerId: PLAYER_IDS[index]!,
    seat: seats[index]!,
    stack,
  }));
}

export function startHand(
  stacks: readonly number[],
  options: {
    readonly buttonSeat?: Seat;
    readonly seats?: readonly Seat[];
    readonly smallBlind?: number;
    readonly bigBlind?: number;
  } = {},
): BettingState {
  return createBettingState({
    participants: participantInputs(stacks, options.seats),
    buttonSeat: options.buttonSeat ?? 0,
    smallBlind: options.smallBlind ?? 1,
    bigBlind: options.bigBlind ?? 2,
  });
}

export function act(
  state: BettingState,
  type: BettingCommand["type"],
  amount?: number,
): BettingState {
  if (state.currentActorId === null) {
    throw new Error("Test attempted to act without a current actor");
  }

  if (type === PlayerActionType.Bet) {
    return applyAction(state, { playerId: state.currentActorId, type, amount: amount! });
  }
  if (type === PlayerActionType.Raise) {
    return applyAction(state, { playerId: state.currentActorId, type, raiseTo: amount! });
  }
  return applyAction(state, { playerId: state.currentActorId, type });
}

export function advanceToFlop(
  desiredFlopStacks: readonly number[],
  options: { readonly buttonSeat?: Seat; readonly seats?: readonly Seat[] } = {},
): BettingState {
  let state = startHand(
    desiredFlopStacks.map((stack) => stack + 2),
    options,
  );

  while (state.status === BettingStatus.Betting && state.street === Street.Preflop) {
    const legal = legalActions(state);
    state = act(state, legal.canCall ? PlayerActionType.Call : PlayerActionType.Check);
  }

  if (state.status !== BettingStatus.Betting || state.street !== Street.Flop) {
    throw new Error("Test setup did not reach an actionable flop");
  }
  return state;
}

export function player(state: BettingState, playerId: string): HandParticipant {
  const found = state.participants.find((participant) => participant.playerId === playerId);
  if (found === undefined) {
    throw new Error(`Missing test participant ${playerId}`);
  }
  return found;
}

export function assertChipInvariant(state: BettingState): void {
  for (const participant of state.participants) {
    if (participant.stack < 0 || participant.streetContribution < 0 || participant.totalContribution < 0) {
      throw new Error(`Negative chip value for ${participant.playerId}`);
    }
    if (participant.stack + participant.totalContribution !== participant.startingStack) {
      throw new Error(`Chip invariant failed for ${participant.playerId}`);
    }
  }
}
