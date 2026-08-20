/**
 * Browser-safe wire contracts.
 *
 * This package deliberately contains DTOs and protocol constants only. It does
 * not import the poker engine, server runtime, persistence layer, or identity
 * implementation.
 */

export type PlayerId = string;

export type TableSeat = 0 | 1 | 2 | 3 | 4 | 5;

export const TABLE_SEAT_COUNT = 6;

export const TableLifecycleStatus = Object.freeze({
  NoSession: "NO_SESSION",
  WaitingForFirstHand: "SESSION_WAITING_FOR_FIRST_HAND",
  HandInProgress: "HAND_IN_PROGRESS",
  BetweenHands: "BETWEEN_HANDS",
  SessionEnded: "SESSION_ENDED",
} as const);

export type TableLifecycleStatus =
  (typeof TableLifecycleStatus)[keyof typeof TableLifecycleStatus];

export const HandLifecycleStatus = Object.freeze({
  Betting: "BETTING",
  RunoutRequired: "RUNOUT_REQUIRED",
  Complete: "COMPLETE",
} as const);

export type HandLifecycleStatus =
  (typeof HandLifecycleStatus)[keyof typeof HandLifecycleStatus];

export const Street = Object.freeze({
  Preflop: "PREFLOP",
  Flop: "FLOP",
  Turn: "TURN",
  River: "RIVER",
} as const);

export type Street = (typeof Street)[keyof typeof Street];

export const LedgerEntryType = Object.freeze({
  InitialGrant: "INITIAL_GRANT",
  Replenishment: "REPLENISHMENT",
  HostAdjustment: "HOST_ADJUSTMENT",
} as const);

export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type CardSuit = "c" | "d" | "h" | "s";

export interface Card {
  readonly rank: CardRank;
  readonly suit: CardSuit;
}

export type PlayerActionType = "FOLD" | "CHECK" | "CALL" | "BET" | "RAISE" | "ALL_IN";
export type ActionSemantic = "FOLD" | "CHECK" | "CALL" | "BET" | "RAISE";

export interface PublicActionRecord {
  readonly type: "ACTION";
  readonly playerId: PlayerId;
  readonly sequence: number;
  readonly street: Street;
  readonly requestedType: PlayerActionType;
  readonly semantic: ActionSemantic;
  readonly amountCommitted: number;
  readonly toContribution: number;
  readonly isAllIn: boolean;
  readonly isFullBetOrRaise: boolean;
}

export interface PublicPlayerProjection {
  readonly playerId: PlayerId;
  readonly nickname: string | null;
  readonly seat: TableSeat | null;
  readonly present: boolean;
  readonly online: boolean;
  readonly pendingLeaveAfterHand: boolean;
  readonly chipBalance: number;
}

export interface CurrentHandParticipantProjection {
  readonly playerId: PlayerId;
  readonly seat: number;
  readonly startingStack: number;
  readonly stack: number;
  readonly streetContribution: number;
  readonly totalContribution: number;
  readonly folded: boolean;
  readonly allIn: boolean;
}

export interface CurrentHandProjection {
  readonly handId: string;
  readonly status: HandLifecycleStatus;
  readonly participants: readonly CurrentHandParticipantProjection[];
  readonly buttonSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly street: Street;
  readonly currentActorId: PlayerId | null;
  readonly currentBet: number;
  readonly potSize: number;
  readonly board: readonly Card[];
  readonly actions: readonly PublicActionRecord[];
}

export interface PublicLedgerEntryProjection {
  readonly ledgerEntryId: string;
  readonly sessionId: string;
  readonly playerId: PlayerId;
  readonly amount: number;
  readonly type: LedgerEntryType;
  readonly operatorPlayerId: PlayerId | null;
  readonly sequence: number;
}

export interface SessionProjection {
  readonly sessionId: string;
  readonly blinds: { readonly smallBlind: number; readonly bigBlind: number };
  readonly completedHandCount: number;
  readonly lastButtonSeat: TableSeat | null;
  readonly ledger: readonly PublicLedgerEntryProjection[];
}

export interface PublicSessionPlayerSummary {
  readonly playerId: PlayerId;
  readonly initialGrants: number;
  readonly replenishments: number;
  readonly hostAdjustments: number;
  readonly finalChipBalance: number;
  readonly netResult: number;
}

export interface PublicSessionSummary {
  readonly sessionId: string;
  readonly participantPlayerIds: readonly PlayerId[];
  readonly players: readonly PublicSessionPlayerSummary[];
  readonly handCount: number;
}

export interface PublicHandParticipant {
  readonly playerId: PlayerId;
  readonly seat: number;
  readonly startingStack: number;
}

export interface PublicRevealedHoleCards {
  readonly playerId: PlayerId;
  readonly cards: readonly [Card, Card];
  readonly reason: "SHOWDOWN" | "VOLUNTARY_UNCONTESTED";
}

export type PublicHandEvent =
  | PublicActionRecord
  | {
      readonly type: "ADMINISTRATIVE_FOLD";
      readonly sequence: number;
      readonly handId: string;
      readonly targetPlayerId: PlayerId;
      readonly reason: "DISCONNECT_TIMEOUT" | "EXPLICIT_LEAVE" | "KICK" | "HOST_FORCE_FOLD";
      readonly operatorPlayerId: PlayerId | null;
    }
  | {
      readonly type: "BOARD_REVEALED";
      readonly sequence: number;
      readonly street: "FLOP" | "TURN" | "RIVER";
      readonly cards: readonly Card[];
    }
  | {
      readonly type: "HOLE_CARDS_REVEALED";
      readonly sequence: number;
      readonly reason: "SHOWDOWN" | "VOLUNTARY_UNCONTESTED";
      readonly hands: readonly PublicRevealedHoleCards[];
    }
  | {
      readonly type: "HAND_SETTLED";
      readonly sequence: number;
      readonly reason: "SHOWDOWN" | "UNCONTESTED";
    };

export type PublicHandCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface PublicHandRank {
  readonly category: PublicHandCategory;
  readonly tiebreakers: readonly number[];
  readonly bestFive: readonly Card[];
}

export interface PublicPlayerAmount {
  readonly playerId: PlayerId;
  readonly amount: number;
}

export interface PublicPotPayout extends PublicPlayerAmount {
  readonly oddChips: number;
}

export type PublicPotKind = "MAIN" | "SIDE";

export interface PublicConstructedPot {
  readonly potIndex: number;
  readonly kind: PublicPotKind;
  readonly contributionFrom: number;
  readonly contributionTo: number;
  readonly amount: number;
  readonly contributorPlayerIds: readonly PlayerId[];
  readonly eligiblePlayerIds: readonly PlayerId[];
}

export interface PublicSettledPot extends PublicConstructedPot {
  readonly winnerPlayerIds: readonly PlayerId[];
  readonly payouts: readonly PublicPotPayout[];
}

export interface PublicEvaluatedHand {
  readonly playerId: PlayerId;
  readonly handRank: PublicHandRank;
}

export interface PublicFinalStack {
  readonly playerId: PlayerId;
  readonly seat: number;
  readonly stack: number;
}

export interface PublicHandSettlementResult {
  readonly refunds: readonly PublicPlayerAmount[];
  readonly pots: readonly PublicSettledPot[];
  readonly evaluatedHands: readonly PublicEvaluatedHand[];
  readonly totalPayouts: readonly PublicPlayerAmount[];
  readonly finalStacks: readonly PublicFinalStack[];
  readonly totalContribution: number;
  readonly totalRefund: number;
  readonly totalPotAmount: number;
  readonly totalPotPayout: number;
  readonly totalStartingStacks: number;
  readonly totalFinalStacks: number;
}

/** Safe history fields are intentionally opaque where M10 does not consume them. */
export interface PublicSafeHandRecord {
  readonly handId: string;
  readonly participants: readonly PublicHandParticipant[];
  readonly buttonSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly actions: readonly PublicActionRecord[];
  readonly board: readonly Card[];
  readonly flop: readonly Card[];
  readonly turn: Card | null;
  readonly river: Card | null;
  readonly events: readonly PublicHandEvent[];
  readonly completionReason: "SHOWDOWN" | "UNCONTESTED" | null;
  readonly settlement: PublicHandSettlementResult | null;
  readonly revealedHoleCards: readonly PublicRevealedHoleCards[];
}

export interface PublicTableHandRecord {
  readonly sessionId: string;
  readonly handNumber: number;
  readonly record: PublicSafeHandRecord;
}

export interface SafeTableProjection {
  readonly version: number;
  readonly status: TableLifecycleStatus;
  readonly hostPlayerId: PlayerId | null;
  readonly seats: readonly (PublicPlayerProjection | null)[];
  readonly spectators: readonly PublicPlayerProjection[];
  readonly session: SessionProjection | null;
  readonly currentHand: CurrentHandProjection | null;
  readonly ownHoleCards: readonly [Card, Card] | null;
  readonly recentHands: readonly PublicTableHandRecord[];
  readonly recentSessions: readonly PublicSessionSummary[];
}

export const TransportEvent = Object.freeze({
  TableCommand: "TABLE_COMMAND",
  TableState: "TABLE_STATE",
  IdentityRevoked: "IDENTITY_REVOKED",
} as const);

export interface IdentityResponse {
  readonly status: "CREATED" | "RESTORED" | "REENTERED";
  readonly playerId: PlayerId;
  readonly nickname: string;
}

export type EntryPosition =
  | { readonly kind: "SPECTATOR" }
  | { readonly kind: "SEAT"; readonly seat: TableSeat };

export interface TransportErrorResponse {
  readonly error: string;
  readonly message: string;
}

export const M10CommandType = Object.freeze({
  Sit: "SIT",
  StandToSpectate: "STAND_TO_SPECTATE",
  LeaveTable: "LEAVE_TABLE",
} as const);

export type M10Command =
  | { readonly type: typeof M10CommandType.Sit; readonly seat: TableSeat }
  | { readonly type: typeof M10CommandType.StandToSpectate }
  | { readonly type: typeof M10CommandType.LeaveTable };

export interface M10ClientCommandInput {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly command: M10Command;
}

export type CommandRejectionReason =
  | "STALE_VERSION"
  | "UNAUTHORIZED_IDENTITY"
  | "DOMAIN_RULE_REJECTION"
  | "INVALID_COMMAND";

export interface CommandResultDataNone {
  readonly kind: "NONE";
}

export type CommandResultData = CommandResultDataNone | { readonly kind: string; readonly [key: string]: unknown };

export interface CommandSuccessResult {
  readonly status: "APPLIED" | "NO_OP";
  readonly commandId: string;
  readonly version: number;
  readonly data: CommandResultData;
  readonly projection: SafeTableProjection;
}

export interface CommandDuplicateResult {
  readonly status: "DUPLICATE";
  readonly commandId: string;
  readonly version: number;
  readonly originalVersion: number;
  readonly originalStatus: "APPLIED" | "NO_OP";
  readonly data: CommandResultData;
  readonly projection: SafeTableProjection;
}

export interface CommandRejectedResult {
  readonly status: "REJECTED";
  readonly commandId: string;
  readonly version: number;
  readonly reason: CommandRejectionReason;
  readonly message: string;
  readonly projection: SafeTableProjection;
}

export type CommandResult =
  | CommandSuccessResult
  | CommandDuplicateResult
  | CommandRejectedResult;

export interface ServerToClientEvents {
  TABLE_STATE: (projection: SafeTableProjection) => void;
  IDENTITY_REVOKED: (event: { readonly reason: "KICKED" | "SESSION_ENDED" }) => void;
}

export interface M10ClientToServerEvents {
  TABLE_COMMAND: (
    input: M10ClientCommandInput,
    acknowledge: (result: CommandResult) => void,
  ) => void;
}
