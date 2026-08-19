import type {
  PlayerActionType,
  TableLifecycleStatus,
} from "@friend-poker/poker-engine";
import type {
  BettingActionRecord,
  Card,
  DomainMetadata,
  HandActionEvent,
  HandLifecycleStatus,
  LedgerEntryType,
  PlayerId,
  RandomSource,
  SafeHandRecord,
  SessionEndPreview,
  SessionPlayerSummary,
  Street,
  TableHandRecord,
  TableSeat,
  TableState,
} from "@friend-poker/poker-engine";

export const RuntimeCommandType = Object.freeze({
  EnterTable: "ENTER_TABLE",
  Sit: "SIT",
  StandToSpectate: "STAND_TO_SPECTATE",
  LeaveTable: "LEAVE_TABLE",
  SetOnline: "SET_ONLINE",
  StartSession: "START_SESSION",
  StartFirstHand: "START_FIRST_HAND",
  StartNextHand: "START_NEXT_HAND",
  PokerAction: "POKER_ACTION",
  AdvanceRunout: "ADVANCE_RUNOUT",
  RevealUncontested: "REVEAL_UNCONTESTED",
  Replenish: "REPLENISH",
  HostAdjustChips: "HOST_ADJUST_CHIPS",
  ChangeBlinds: "CHANGE_BLINDS",
  TransferHost: "TRANSFER_HOST",
  Kick: "KICK",
  PrepareEndSession: "PREPARE_END_SESSION",
  EndSession: "END_SESSION",
} as const);

export type RuntimeCommandType =
  (typeof RuntimeCommandType)[keyof typeof RuntimeCommandType];

export const CommandRejectionReason = Object.freeze({
  StaleVersion: "STALE_VERSION",
  UnauthorizedIdentity: "UNAUTHORIZED_IDENTITY",
  DomainRule: "DOMAIN_RULE_REJECTION",
  InvalidCommand: "INVALID_COMMAND",
} as const);

export type CommandRejectionReason =
  (typeof CommandRejectionReason)[keyof typeof CommandRejectionReason];

export interface PlayerPrincipal {
  readonly kind: "PLAYER";
  readonly playerId: PlayerId;
}

export interface SystemPrincipal {
  readonly kind: "SYSTEM";
  readonly systemId: string;
}

export type RuntimePrincipal = PlayerPrincipal | SystemPrincipal;

export interface SpectatorViewer {
  readonly kind: "SPECTATOR";
}

export type TableViewer = PlayerPrincipal | SpectatorViewer;

export type RuntimePokerAction =
  | { readonly type: typeof PlayerActionType.Fold }
  | { readonly type: typeof PlayerActionType.Check }
  | { readonly type: typeof PlayerActionType.Call }
  | { readonly type: typeof PlayerActionType.Bet; readonly amount: number }
  | { readonly type: typeof PlayerActionType.Raise; readonly raiseTo: number }
  | { readonly type: typeof PlayerActionType.AllIn };

export type RuntimeCommand =
  | {
      readonly type: typeof RuntimeCommandType.EnterTable;
      readonly nickname?: string;
      readonly online?: boolean;
      readonly position:
        | { readonly kind: "SPECTATOR" }
        | { readonly kind: "SEAT"; readonly seat: TableSeat };
      readonly initialGrant?: {
        readonly ledgerEntryId: string;
        readonly metadata?: DomainMetadata;
      };
    }
  | {
      readonly type: typeof RuntimeCommandType.Sit;
      readonly seat: TableSeat;
      readonly initialGrant?: {
        readonly ledgerEntryId: string;
        readonly metadata?: DomainMetadata;
      };
    }
  | { readonly type: typeof RuntimeCommandType.StandToSpectate }
  | { readonly type: typeof RuntimeCommandType.LeaveTable }
  | {
      readonly type: typeof RuntimeCommandType.SetOnline;
      readonly targetPlayerId: PlayerId;
      readonly online: boolean;
    }
  | {
      readonly type: typeof RuntimeCommandType.StartSession;
      readonly sessionId: string;
      readonly initialGrants: readonly {
        readonly playerId: PlayerId;
        readonly ledgerEntryId: string;
        readonly metadata?: DomainMetadata;
      }[];
      readonly startMetadata?: DomainMetadata;
    }
  | {
      readonly type: typeof RuntimeCommandType.StartFirstHand;
      readonly handId: string;
      readonly buttonSeat: TableSeat;
    }
  | {
      readonly type: typeof RuntimeCommandType.StartNextHand;
      readonly handId: string;
    }
  | {
      readonly type: typeof RuntimeCommandType.PokerAction;
      readonly action: RuntimePokerAction;
    }
  | { readonly type: typeof RuntimeCommandType.AdvanceRunout }
  | { readonly type: typeof RuntimeCommandType.RevealUncontested }
  | {
      readonly type: typeof RuntimeCommandType.Replenish;
      readonly ledgerEntryId: string;
      readonly metadata?: DomainMetadata;
    }
  | {
      readonly type: typeof RuntimeCommandType.HostAdjustChips;
      readonly targetPlayerId: PlayerId;
      readonly amount: number;
      readonly ledgerEntryId: string;
      readonly metadata?: DomainMetadata;
    }
  | {
      readonly type: typeof RuntimeCommandType.ChangeBlinds;
      readonly smallBlind: number;
      readonly bigBlind: number;
    }
  | {
      readonly type: typeof RuntimeCommandType.TransferHost;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly type: typeof RuntimeCommandType.Kick;
      readonly targetPlayerId: PlayerId;
    }
  | { readonly type: typeof RuntimeCommandType.PrepareEndSession }
  | {
      readonly type: typeof RuntimeCommandType.EndSession;
      readonly confirmation: SessionEndPreview;
      readonly endMetadata?: DomainMetadata;
    };

export interface CommandEnvelope {
  readonly commandId: string;
  readonly actorId: string;
  readonly expectedVersion: number;
  readonly command: RuntimeCommand;
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
  readonly actions: readonly HandActionEvent[];
}

export interface SessionProjection {
  readonly sessionId: string;
  readonly blinds: { readonly smallBlind: number; readonly bigBlind: number };
  readonly completedHandCount: number;
  readonly lastButtonSeat: TableSeat | null;
  readonly ledger: readonly PublicLedgerEntryProjection[];
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

export interface PublicSessionSummary {
  readonly sessionId: string;
  readonly participantPlayerIds: readonly PlayerId[];
  readonly players: readonly SessionPlayerSummary[];
  readonly handCount: number;
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
  readonly recentHands: readonly TableHandRecord[];
  readonly recentSessions: readonly PublicSessionSummary[];
}

export type RuntimeCommandData =
  | { readonly kind: "NONE" }
  | { readonly kind: "SESSION_END_PREVIEW"; readonly preview: SessionEndPreview };

export interface CommandExecutionSuccess {
  readonly status: "APPLIED" | "NO_OP";
  readonly commandId: string;
  readonly version: number;
  readonly data: RuntimeCommandData;
  readonly projection: SafeTableProjection;
}

export interface DuplicateCommandResult {
  readonly status: "DUPLICATE";
  readonly commandId: string;
  readonly version: number;
  readonly originalVersion: number;
  readonly originalStatus: CommandExecutionSuccess["status"];
  readonly data: RuntimeCommandData;
  readonly projection: SafeTableProjection;
}

export interface RejectedCommandResult {
  readonly status: "REJECTED";
  readonly commandId: string;
  readonly version: number;
  readonly reason: CommandRejectionReason;
  readonly message: string;
  readonly projection: SafeTableProjection;
}

export type CommandExecutionResult =
  | CommandExecutionSuccess
  | DuplicateCommandResult
  | RejectedCommandResult;

export interface RuntimeOptions {
  readonly rngForHand: (handId: string) => RandomSource;
  readonly initialState?: TableState;
  readonly initialVersion?: number;
  readonly processedCommandLimit?: number;
}

export type { BettingActionRecord, SafeHandRecord };
