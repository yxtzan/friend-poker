import type {
  BettingActionRecord,
  BettingCommand,
  BettingState,
  HandParticipantInput,
  PlayerId,
  Seat,
  Street,
} from "../betting/index.js";
import type { HandSettlementResult } from "../settlement/index.js";
import type { Card, Deck } from "../types.js";

export const HandLifecycleStatus = Object.freeze({
  Betting: "BETTING",
  RunoutRequired: "RUNOUT_REQUIRED",
  Complete: "COMPLETE",
} as const);

export type HandLifecycleStatus =
  (typeof HandLifecycleStatus)[keyof typeof HandLifecycleStatus];

export const HandCompletionReason = Object.freeze({
  Showdown: "SHOWDOWN",
  Uncontested: "UNCONTESTED",
} as const);

export type HandCompletionReason =
  (typeof HandCompletionReason)[keyof typeof HandCompletionReason];

export const HoleCardRevealReason = Object.freeze({
  Showdown: "SHOWDOWN",
  VoluntaryUncontested: "VOLUNTARY_UNCONTESTED",
} as const);

export type HoleCardRevealReason =
  (typeof HoleCardRevealReason)[keyof typeof HoleCardRevealReason];

export const AdministrativeFoldReason = Object.freeze({
  DisconnectTimeout: "DISCONNECT_TIMEOUT",
  ExplicitLeave: "EXPLICIT_LEAVE",
  Kick: "KICK",
  HostForceFold: "HOST_FORCE_FOLD",
} as const);

export type AdministrativeFoldReason =
  (typeof AdministrativeFoldReason)[keyof typeof AdministrativeFoldReason];

export interface StartHandInput {
  readonly handId: string;
  readonly participants: readonly HandParticipantInput[];
  readonly buttonSeat: Seat;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

export interface PrivateHoleCards {
  readonly playerId: PlayerId;
  readonly cards: readonly [Card, Card];
}

export interface RevealedHoleCards extends PrivateHoleCards {
  readonly reason: HoleCardRevealReason;
}

export interface HandActionEvent extends BettingActionRecord {
  readonly type: "ACTION";
  readonly sequence: number;
  readonly street: Street;
}

export interface BoardRevealEvent {
  readonly type: "BOARD_REVEALED";
  readonly sequence: number;
  readonly street: Exclude<Street, "PREFLOP">;
  readonly cards: readonly Card[];
}

export interface HoleCardsRevealEvent {
  readonly type: "HOLE_CARDS_REVEALED";
  readonly sequence: number;
  readonly reason: HoleCardRevealReason;
  readonly hands: readonly RevealedHoleCards[];
}

export interface HandSettledEvent {
  readonly type: "HAND_SETTLED";
  readonly sequence: number;
  readonly reason: HandCompletionReason;
}

export interface AdministrativeFoldEvent {
  readonly type: "ADMINISTRATIVE_FOLD";
  readonly sequence: number;
  readonly handId: string;
  readonly targetPlayerId: PlayerId;
  readonly reason: AdministrativeFoldReason;
  readonly operatorPlayerId: PlayerId | null;
}

export type HandEvent =
  | HandActionEvent
  | AdministrativeFoldEvent
  | BoardRevealEvent
  | HoleCardsRevealEvent
  | HandSettledEvent;

export interface AdministrativeFoldInput {
  readonly targetPlayerId: PlayerId;
  readonly reason: AdministrativeFoldReason;
  readonly operatorPlayerId: PlayerId | null;
}

/** Internal authoritative state. It contains private cards and must not be serialized publicly. */
export interface OrchestratedHandState {
  readonly handId: string;
  readonly status: HandLifecycleStatus;
  readonly completionReason: HandCompletionReason | null;
  readonly bettingState: BettingState;
  readonly remainingDeck: Deck;
  readonly privateHoleCards: readonly PrivateHoleCards[];
  readonly board: readonly Card[];
  readonly events: readonly HandEvent[];
  readonly revealedHoleCards: readonly RevealedHoleCards[];
  readonly settlement: HandSettlementResult | null;
}

export interface HandRecordParticipant {
  readonly playerId: PlayerId;
  readonly seat: Seat;
  readonly startingStack: number;
}

/** Safe history projection. It intentionally contains no deck or unrevealed hole-card map. */
export interface SafeHandRecord {
  readonly handId: string;
  readonly participants: readonly HandRecordParticipant[];
  readonly buttonSeat: Seat;
  readonly smallBlindSeat: Seat;
  readonly bigBlindSeat: Seat;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly actions: readonly HandActionEvent[];
  readonly board: readonly Card[];
  readonly flop: readonly Card[];
  readonly turn: Card | null;
  readonly river: Card | null;
  readonly events: readonly HandEvent[];
  readonly completionReason: HandCompletionReason | null;
  readonly settlement: HandSettlementResult | null;
  readonly revealedHoleCards: readonly RevealedHoleCards[];
}

export type HandCommand = BettingCommand;
