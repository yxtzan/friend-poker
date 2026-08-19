export type PlayerId = string;
export type Seat = number;

export const Street = Object.freeze({
  Preflop: "PREFLOP",
  Flop: "FLOP",
  Turn: "TURN",
  River: "RIVER",
} as const);

export type Street = (typeof Street)[keyof typeof Street];

export const BettingStatus = Object.freeze({
  Betting: "BETTING",
  RunoutRequired: "RUNOUT_REQUIRED",
  ShowdownPending: "SHOWDOWN_PENDING",
  Uncontested: "UNCONTESTED",
} as const);

export type BettingStatus = (typeof BettingStatus)[keyof typeof BettingStatus];

export const PlayerActionType = Object.freeze({
  Fold: "FOLD",
  Check: "CHECK",
  Call: "CALL",
  Bet: "BET",
  Raise: "RAISE",
  AllIn: "ALL_IN",
} as const);

export type PlayerActionType = (typeof PlayerActionType)[keyof typeof PlayerActionType];

export const ActionSemantic = Object.freeze({
  Fold: "FOLD",
  Check: "CHECK",
  Call: "CALL",
  Bet: "BET",
  Raise: "RAISE",
} as const);

export type ActionSemantic = (typeof ActionSemantic)[keyof typeof ActionSemantic];

export interface HandParticipantInput {
  readonly playerId: PlayerId;
  readonly seat: Seat;
  readonly stack: number;
}

export interface HandParticipant {
  readonly playerId: PlayerId;
  readonly seat: Seat;
  readonly startingStack: number;
  readonly stack: number;
  readonly streetContribution: number;
  readonly totalContribution: number;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** Highest street bet level this player faced when they most recently acted. */
  readonly lastActionBetLevel: number | null;
  /** Derived from lastActionBetLevel and the current full-raise increment. */
  readonly raiseRightsOpen: boolean;
}

export interface StartBettingHandInput {
  readonly participants: readonly HandParticipantInput[];
  readonly buttonSeat: Seat;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

export interface BettingActionRecord {
  readonly playerId: PlayerId;
  readonly requestedType: PlayerActionType;
  readonly semantic: ActionSemantic;
  readonly amountCommitted: number;
  readonly toContribution: number;
  readonly isAllIn: boolean;
  readonly isFullBetOrRaise: boolean;
}

export interface BettingState {
  readonly participants: readonly HandParticipant[];
  readonly buttonSeat: Seat;
  readonly smallBlindSeat: Seat;
  readonly bigBlindSeat: Seat;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly street: Street;
  readonly status: BettingStatus;
  readonly currentActorId: PlayerId | null;
  readonly currentBet: number;
  /** Size of the most recent full opening bet or full raise increment. */
  readonly lastFullRaiseIncrement: number;
  readonly uncontestedWinnerId: PlayerId | null;
  readonly lastAction: BettingActionRecord | null;
}

export type BettingCommand =
  | { readonly playerId: PlayerId; readonly type: typeof PlayerActionType.Fold }
  | { readonly playerId: PlayerId; readonly type: typeof PlayerActionType.Check }
  | { readonly playerId: PlayerId; readonly type: typeof PlayerActionType.Call }
  | {
      readonly playerId: PlayerId;
      readonly type: typeof PlayerActionType.Bet;
      /** Opening street contribution after the action. */
      readonly amount: number;
    }
  | {
      readonly playerId: PlayerId;
      readonly type: typeof PlayerActionType.Raise;
      /** Total current-street contribution after the action. */
      readonly raiseTo: number;
    }
  | { readonly playerId: PlayerId; readonly type: typeof PlayerActionType.AllIn };

export interface LegalActions {
  readonly playerId: PlayerId;
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** Chips actually committed by Call; may be a short all-in call. */
  readonly callAmount: number;
  readonly callIsAllIn: boolean;
  readonly canBet: boolean;
  readonly minimumBet: number | null;
  readonly maximumBet: number | null;
  readonly canRaise: boolean;
  readonly minimumRaiseTo: number | null;
  readonly maximumRaiseTo: number | null;
  readonly raiseRightsOpen: boolean;
  readonly canAllIn: boolean;
  readonly allInTo: number;
}

export interface BlindPositions {
  readonly buttonSeat: Seat;
  readonly smallBlindSeat: Seat;
  readonly bigBlindSeat: Seat;
  readonly firstPreflopSeat: Seat;
  readonly firstPostflopSeat: Seat;
}
