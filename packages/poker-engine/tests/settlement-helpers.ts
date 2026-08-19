import { BettingStatus, Street } from "../src/index.js";
import type { BettingState, Card, PlayerId, Seat } from "../src/index.js";
import { cards } from "./helpers.js";

interface ParticipantSpec {
  readonly playerId: PlayerId;
  readonly seat: Seat;
  readonly contribution: number;
  readonly stack?: number;
  readonly folded?: boolean;
  readonly allIn?: boolean;
}

export function settlementState(
  specs: readonly ParticipantSpec[],
  options: {
    readonly buttonSeat?: Seat;
    readonly status?: BettingState["status"];
  } = {},
): BettingState {
  const participants = specs.map((spec) => {
    const stack = spec.stack ?? 100;
    return Object.freeze({
      playerId: spec.playerId,
      seat: spec.seat,
      startingStack: stack + spec.contribution,
      stack,
      streetContribution: 0,
      totalContribution: spec.contribution,
      folded: spec.folded ?? false,
      allIn: spec.allIn ?? stack === 0,
      lastActionBetLevel: null,
      raiseRightsOpen: false,
    });
  });
  const status = options.status ?? BettingStatus.ShowdownPending;
  const contenders = participants.filter((participant) => !participant.folded);
  return Object.freeze({
    participants: Object.freeze(participants),
    buttonSeat: options.buttonSeat ?? participants[0]!.seat,
    smallBlindSeat: participants[0]!.seat,
    bigBlindSeat: participants[1]!.seat,
    smallBlind: 1,
    bigBlind: 2,
    street: Street.River,
    status,
    currentActorId: null,
    currentBet: 0,
    lastFullRaiseIncrement: 2,
    uncontestedWinnerId:
      status === BettingStatus.Uncontested && contenders.length === 1
        ? contenders[0]!.playerId
        : null,
    lastAction: null,
  });
}

export function holeCards(
  values: Readonly<Record<PlayerId, string>>,
): Readonly<Record<PlayerId, readonly Card[]>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([playerId, notation]) => [playerId, cards(notation)]),
    ),
  );
}

export function amountFor(
  values: readonly { readonly playerId: PlayerId; readonly amount: number }[],
  playerId: PlayerId,
): number {
  const value = values.find((candidate) => candidate.playerId === playerId);
  if (value === undefined) throw new Error(`Missing amount for ${playerId}`);
  return value.amount;
}

export function stackFor(
  values: readonly { readonly playerId: PlayerId; readonly stack: number }[],
  playerId: PlayerId,
): number {
  const value = values.find((candidate) => candidate.playerId === playerId);
  if (value === undefined) throw new Error(`Missing stack for ${playerId}`);
  return value.stack;
}
