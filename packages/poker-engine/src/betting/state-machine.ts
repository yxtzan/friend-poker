import { BettingRuleError } from "./errors.js";
import { determineBlindPositions, nextEligibleSeat } from "./seats.js";
import {
  ActionSemantic,
  BettingStatus,
  PlayerActionType,
  Street,
} from "./types.js";
import type {
  BettingActionRecord,
  BettingCommand,
  BettingState,
  HandParticipant,
  HandParticipantInput,
  LegalActions,
  PlayerId,
  Seat,
  StartBettingHandInput,
} from "./types.js";

interface MutableParticipant {
  playerId: PlayerId;
  seat: Seat;
  startingStack: number;
  stack: number;
  streetContribution: number;
  totalContribution: number;
  folded: boolean;
  allIn: boolean;
  lastActionBetLevel: number | null;
  raiseRightsOpen: boolean;
}

interface MutableState {
  participants: MutableParticipant[];
  buttonSeat: Seat;
  smallBlindSeat: Seat;
  bigBlindSeat: Seat;
  smallBlind: number;
  bigBlind: number;
  street: BettingState["street"];
  status: BettingState["status"];
  currentActorId: PlayerId | null;
  currentBet: number;
  lastFullRaiseIncrement: number;
  uncontestedWinnerId: PlayerId | null;
  lastAction: BettingActionRecord | null;
}

function assertInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer of at least ${minimum}`);
  }
}

function validateParticipants(inputs: readonly HandParticipantInput[]): void {
  if (inputs.length < 2 || inputs.length > 6) {
    throw new RangeError("A hand requires between 2 and 6 participants");
  }

  const playerIds = new Set<PlayerId>();
  const seats = new Set<Seat>();
  for (const input of inputs) {
    if (input.playerId.length === 0) {
      throw new RangeError("Player id must not be empty");
    }
    if (playerIds.has(input.playerId)) {
      throw new RangeError("Player ids must be unique");
    }
    playerIds.add(input.playerId);

    assertInteger(input.seat, "Seat");
    if (seats.has(input.seat)) {
      throw new RangeError("Participant seats must be unique");
    }
    seats.add(input.seat);

    assertInteger(input.stack, "Starting stack", 1);
  }
}

function cloneParticipant(participant: HandParticipant): MutableParticipant {
  return { ...participant };
}

function refreshRaiseRights(state: MutableState): void {
  for (const participant of state.participants) {
    participant.raiseRightsOpen =
      !participant.folded &&
      !participant.allIn &&
      (participant.lastActionBetLevel === null ||
        state.currentBet - participant.lastActionBetLevel >= state.lastFullRaiseIncrement);
  }
}

function freezeAction(action: BettingActionRecord | null): BettingActionRecord | null {
  return action === null ? null : Object.freeze({ ...action });
}

function freezeState(state: MutableState): BettingState {
  refreshRaiseRights(state);
  const participants = state.participants.map((participant) => Object.freeze({ ...participant }));
  return Object.freeze({
    ...state,
    participants: Object.freeze(participants),
    lastAction: freezeAction(state.lastAction),
  });
}

function toMutableState(state: BettingState): MutableState {
  return {
    ...state,
    participants: state.participants.map(cloneParticipant),
    lastAction: state.lastAction === null ? null : { ...state.lastAction },
  };
}

function isContender(participant: MutableParticipant): boolean {
  return !participant.folded;
}

function isActionable(participant: MutableParticipant): boolean {
  return !participant.folded && !participant.allIn;
}

function needsAction(participant: MutableParticipant, currentBet: number): boolean {
  return (
    isActionable(participant) &&
    (participant.lastActionBetLevel === null || participant.streetContribution < currentBet)
  );
}

function participantById(state: MutableState, playerId: PlayerId): MutableParticipant {
  const participant = state.participants.find((candidate) => candidate.playerId === playerId);
  if (participant === undefined) {
    throw new BettingRuleError(`Unknown hand participant: ${playerId}`);
  }
  return participant;
}

function nextPlayerAfter(
  fromSeat: Seat,
  participants: readonly MutableParticipant[],
): MutableParticipant {
  const nextSeat = nextEligibleSeat(
    fromSeat,
    participants.map((participant) => participant.seat),
  );
  return participants.find((participant) => participant.seat === nextSeat)!;
}

function nextStreet(street: BettingState["street"]): BettingState["street"] | null {
  switch (street) {
    case Street.Preflop:
      return Street.Flop;
    case Street.Flop:
      return Street.Turn;
    case Street.Turn:
      return Street.River;
    case Street.River:
      return null;
  }
}

function finishWithoutFurtherBetting(state: MutableState): void {
  state.currentActorId = null;
  state.uncontestedWinnerId = null;
  state.status =
    state.street === Street.River ? BettingStatus.ShowdownPending : BettingStatus.RunoutRequired;
}

function advanceStreet(state: MutableState): void {
  const upcomingStreet = nextStreet(state.street);
  if (upcomingStreet === null) {
    state.status = BettingStatus.ShowdownPending;
    state.currentActorId = null;
    state.uncontestedWinnerId = null;
    return;
  }

  state.street = upcomingStreet;
  state.currentBet = 0;
  state.lastFullRaiseIncrement = state.bigBlind;
  for (const participant of state.participants) {
    participant.streetContribution = 0;
    participant.lastActionBetLevel = null;
  }
  refreshRaiseRights(state);

  const actionable = state.participants.filter(isActionable);
  if (actionable.length <= 1) {
    finishWithoutFurtherBetting(state);
    return;
  }

  state.status = BettingStatus.Betting;
  state.currentActorId = nextPlayerAfter(state.buttonSeat, actionable).playerId;
  state.uncontestedWinnerId = null;
}

function progressState(state: MutableState, fromSeat: Seat): void {
  refreshRaiseRights(state);

  const contenders = state.participants.filter(isContender);
  if (contenders.length === 1) {
    state.status = BettingStatus.Uncontested;
    state.currentActorId = null;
    state.uncontestedWinnerId = contenders[0]!.playerId;
    return;
  }

  const actionable = contenders.filter(isActionable);
  if (
    actionable.length === 0 ||
    (actionable.length === 1 && actionable[0]!.streetContribution >= state.currentBet)
  ) {
    finishWithoutFurtherBetting(state);
    return;
  }

  const pending = actionable.filter((participant) => needsAction(participant, state.currentBet));
  if (pending.length === 0) {
    advanceStreet(state);
    return;
  }

  state.status = BettingStatus.Betting;
  state.currentActorId = nextPlayerAfter(fromSeat, pending).playerId;
  state.uncontestedWinnerId = null;
}

function commitChips(participant: MutableParticipant, amount: number): void {
  if (amount < 0 || amount > participant.stack) {
    throw new BettingRuleError("Chip commitment exceeds the participant stack");
  }
  participant.stack -= amount;
  participant.streetContribution += amount;
  participant.totalContribution += amount;
  participant.allIn = participant.stack === 0;
}

function postBlind(participant: MutableParticipant, blind: number): void {
  commitChips(participant, Math.min(blind, participant.stack));
}

function actionRecord(
  playerId: PlayerId,
  requestedType: BettingActionRecord["requestedType"],
  semantic: BettingActionRecord["semantic"],
  amountCommitted: number,
  toContribution: number,
  isAllIn: boolean,
  isFullBetOrRaise: boolean,
): BettingActionRecord {
  return {
    playerId,
    requestedType,
    semantic,
    amountCommitted,
    toContribution,
    isAllIn,
    isFullBetOrRaise,
  };
}

export function createBettingState(input: StartBettingHandInput): BettingState {
  validateParticipants(input.participants);
  assertInteger(input.smallBlind, "Small blind", 1);
  assertInteger(input.bigBlind, "Big blind", 1);
  if (input.smallBlind > input.bigBlind) {
    throw new RangeError("Small blind must not exceed big blind");
  }

  const orderedInputs = [...input.participants].sort((left, right) => left.seat - right.seat);
  const positions = determineBlindPositions(
    input.buttonSeat,
    orderedInputs.map((participant) => participant.seat),
  );
  const participants: MutableParticipant[] = orderedInputs.map((participant) => ({
    playerId: participant.playerId,
    seat: participant.seat,
    startingStack: participant.stack,
    stack: participant.stack,
    streetContribution: 0,
    totalContribution: 0,
    folded: false,
    allIn: false,
    lastActionBetLevel: null,
    raiseRightsOpen: true,
  }));

  const state: MutableState = {
    participants,
    ...positions,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
    street: Street.Preflop,
    status: BettingStatus.Betting,
    currentActorId: null,
    currentBet: input.bigBlind,
    lastFullRaiseIncrement: input.bigBlind,
    uncontestedWinnerId: null,
    lastAction: null,
  };

  postBlind(participantById(state, participants.find((p) => p.seat === positions.smallBlindSeat)!.playerId), input.smallBlind);
  postBlind(participantById(state, participants.find((p) => p.seat === positions.bigBlindSeat)!.playerId), input.bigBlind);
  progressState(state, positions.bigBlindSeat);
  return freezeState(state);
}

function publicParticipantById(state: BettingState, playerId: PlayerId): HandParticipant {
  const participant = state.participants.find((candidate) => candidate.playerId === playerId);
  if (participant === undefined) {
    throw new BettingRuleError(`Unknown hand participant: ${playerId}`);
  }
  return participant;
}

export function legalActions(state: BettingState): LegalActions {
  if (state.status !== BettingStatus.Betting || state.currentActorId === null) {
    throw new BettingRuleError("No player action is currently available");
  }

  const participant = publicParticipantById(state, state.currentActorId);
  const amountToMatch = Math.max(0, state.currentBet - participant.streetContribution);
  const callAmount = Math.min(amountToMatch, participant.stack);
  const allInTo = participant.streetContribution + participant.stack;
  const hasActionableOpponent = state.participants.some(
    (candidate) =>
      candidate.playerId !== participant.playerId && !candidate.folded && !candidate.allIn,
  );
  const mayIncreaseBet = participant.raiseRightsOpen && hasActionableOpponent;
  const minimumRaiseTo =
    state.currentBet > 0 && mayIncreaseBet
      ? state.currentBet + state.lastFullRaiseIncrement
      : null;
  const maximumRaiseTo = state.currentBet > 0 && mayIncreaseBet ? allInTo : null;
  const canRaise =
    minimumRaiseTo !== null && maximumRaiseTo !== null && maximumRaiseTo >= minimumRaiseTo;
  const canAllInCall = amountToMatch > 0 && allInTo <= state.currentBet;
  const canAllInBet = state.currentBet === 0 && hasActionableOpponent;
  const canAllInRaise =
    state.currentBet > 0 && allInTo > state.currentBet && mayIncreaseBet;

  return Object.freeze({
    playerId: participant.playerId,
    canFold: true,
    canCheck: amountToMatch === 0,
    canCall: amountToMatch > 0,
    callAmount,
    callIsAllIn: amountToMatch > 0 && participant.stack <= amountToMatch,
    canBet: state.currentBet === 0 && hasActionableOpponent && participant.stack >= state.bigBlind,
    minimumBet:
      state.currentBet === 0 && hasActionableOpponent ? state.bigBlind : null,
    maximumBet: state.currentBet === 0 && hasActionableOpponent ? participant.stack : null,
    canRaise,
    minimumRaiseTo,
    maximumRaiseTo,
    raiseRightsOpen: participant.raiseRightsOpen,
    canAllIn: participant.stack > 0 && (canAllInCall || canAllInBet || canAllInRaise),
    allInTo,
  });
}

function validateCommandAmount(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BettingRuleError(`${label} must be a positive integer`);
  }
}

export function applyAction(state: BettingState, command: BettingCommand): BettingState {
  if (state.status !== BettingStatus.Betting || state.currentActorId === null) {
    throw new BettingRuleError("The hand is not waiting for a player action");
  }
  if (command.playerId !== state.currentActorId) {
    throw new BettingRuleError(`It is not ${command.playerId}'s turn`);
  }

  const legal = legalActions(state);
  const next = toMutableState(state);
  const participant = participantById(next, command.playerId);
  const fromSeat = participant.seat;

  switch (command.type) {
    case PlayerActionType.Fold: {
      participant.folded = true;
      participant.lastActionBetLevel = next.currentBet;
      next.lastAction = actionRecord(
        participant.playerId,
        command.type,
        ActionSemantic.Fold,
        0,
        participant.streetContribution,
        false,
        false,
      );
      break;
    }
    case PlayerActionType.Check: {
      if (!legal.canCheck) {
        throw new BettingRuleError("Check is illegal while facing a bet");
      }
      participant.lastActionBetLevel = next.currentBet;
      next.lastAction = actionRecord(
        participant.playerId,
        command.type,
        ActionSemantic.Check,
        0,
        participant.streetContribution,
        false,
        false,
      );
      break;
    }
    case PlayerActionType.Call: {
      if (!legal.canCall) {
        throw new BettingRuleError("Call is illegal when no chips are owed");
      }
      const amount = legal.callAmount;
      commitChips(participant, amount);
      participant.lastActionBetLevel = next.currentBet;
      next.lastAction = actionRecord(
        participant.playerId,
        command.type,
        ActionSemantic.Call,
        amount,
        participant.streetContribution,
        participant.allIn,
        false,
      );
      break;
    }
    case PlayerActionType.Bet: {
      validateCommandAmount(command.amount, "Bet amount");
      if (!legal.canBet || legal.minimumBet === null || legal.maximumBet === null) {
        throw new BettingRuleError("Opening Bet is not currently legal");
      }
      if (command.amount < legal.minimumBet) {
        throw new BettingRuleError(`Minimum Bet is ${legal.minimumBet}`);
      }
      if (command.amount > legal.maximumBet) {
        throw new BettingRuleError("Bet exceeds the participant stack");
      }
      commitChips(participant, command.amount);
      next.currentBet = command.amount;
      next.lastFullRaiseIncrement = command.amount;
      participant.lastActionBetLevel = next.currentBet;
      next.lastAction = actionRecord(
        participant.playerId,
        command.type,
        ActionSemantic.Bet,
        command.amount,
        participant.streetContribution,
        participant.allIn,
        true,
      );
      break;
    }
    case PlayerActionType.Raise: {
      validateCommandAmount(command.raiseTo, "Raise-to amount");
      if (
        !legal.canRaise ||
        legal.minimumRaiseTo === null ||
        legal.maximumRaiseTo === null
      ) {
        throw new BettingRuleError("Raise is not currently legal");
      }
      if (command.raiseTo < legal.minimumRaiseTo) {
        throw new BettingRuleError(`Minimum Raise-to is ${legal.minimumRaiseTo}`);
      }
      if (command.raiseTo > legal.maximumRaiseTo) {
        throw new BettingRuleError("Raise exceeds the participant stack");
      }

      const previousBet = next.currentBet;
      const amount = command.raiseTo - participant.streetContribution;
      commitChips(participant, amount);
      next.currentBet = command.raiseTo;
      next.lastFullRaiseIncrement = command.raiseTo - previousBet;
      participant.lastActionBetLevel = next.currentBet;
      next.lastAction = actionRecord(
        participant.playerId,
        command.type,
        ActionSemantic.Raise,
        amount,
        participant.streetContribution,
        participant.allIn,
        true,
      );
      break;
    }
    case PlayerActionType.AllIn: {
      if (!legal.canAllIn) {
        throw new BettingRuleError("All-in is not currently legal");
      }

      const previousBet = next.currentBet;
      const previousContribution = participant.streetContribution;
      const target = legal.allInTo;
      const amount = participant.stack;
      commitChips(participant, amount);

      let semantic: BettingActionRecord["semantic"];
      let isFullBetOrRaise = false;
      if (target <= previousBet) {
        semantic = ActionSemantic.Call;
      } else if (previousBet === 0) {
        semantic = ActionSemantic.Bet;
        next.currentBet = target;
        if (target >= next.bigBlind) {
          next.lastFullRaiseIncrement = target;
          isFullBetOrRaise = true;
        }
      } else {
        semantic = ActionSemantic.Raise;
        const raiseIncrement = target - previousBet;
        next.currentBet = target;
        if (raiseIncrement >= next.lastFullRaiseIncrement) {
          next.lastFullRaiseIncrement = raiseIncrement;
          isFullBetOrRaise = true;
        }
      }

      participant.lastActionBetLevel = next.currentBet;
      next.lastAction = actionRecord(
        participant.playerId,
        command.type,
        semantic,
        amount,
        previousContribution + amount,
        true,
        isFullBetOrRaise,
      );
      break;
    }
  }

  progressState(next, fromSeat);
  return freezeState(next);
}
