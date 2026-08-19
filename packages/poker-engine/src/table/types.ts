import type { HandCommand, OrchestratedHandState, SafeHandRecord } from "../hand/index.js";
import type { PlayerId, Seat } from "../betting/index.js";

export const TABLE_SEAT_COUNT = 6;
export const SPECTATOR_SLOT_COUNT = 2;
export const INITIAL_CHIP_GRANT = 100;
export const REPLENISHMENT_AMOUNT = 100;
export const RECENT_HISTORY_LIMIT = 20;

export type TableSeat = 0 | 1 | 2 | 3 | 4 | 5;

export const TableLifecycleStatus = Object.freeze({
  NoSession: "NO_SESSION",
  WaitingForFirstHand: "SESSION_WAITING_FOR_FIRST_HAND",
  HandInProgress: "HAND_IN_PROGRESS",
  BetweenHands: "BETWEEN_HANDS",
  SessionEnded: "SESSION_ENDED",
} as const);

export type TableLifecycleStatus =
  (typeof TableLifecycleStatus)[keyof typeof TableLifecycleStatus];

export const LedgerEntryType = Object.freeze({
  InitialGrant: "INITIAL_GRANT",
  Replenishment: "REPLENISHMENT",
  HostAdjustment: "HOST_ADJUSTMENT",
} as const);

export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export type DomainMetadataValue = string | number | boolean | null;
export type DomainMetadata = Readonly<Record<string, DomainMetadataValue>>;

export interface ChipLedgerEntry {
  readonly ledgerEntryId: string;
  readonly sessionId: string;
  readonly playerId: PlayerId;
  readonly amount: number;
  readonly type: LedgerEntryType;
  readonly operatorPlayerId: PlayerId | null;
  readonly sequence: number;
  readonly metadata: DomainMetadata | null;
}

export interface TablePlayer {
  readonly playerId: PlayerId;
  readonly nickname: string | null;
  readonly seat: TableSeat | null;
  readonly present: boolean;
  readonly online: boolean;
  readonly pendingLeaveAfterHand: boolean;
  readonly sessionParticipant: boolean;
  readonly initialGrantReceived: boolean;
  readonly chipBalance: number;
}

export interface BlindConfiguration {
  readonly smallBlind: number;
  readonly bigBlind: number;
}

export interface ActiveSession {
  readonly sessionId: string;
  readonly blinds: BlindConfiguration;
  readonly ledger: readonly ChipLedgerEntry[];
  readonly participantPlayerIds: readonly PlayerId[];
  readonly completedHandCount: number;
  readonly lastButtonSeat: TableSeat | null;
  readonly startMetadata: DomainMetadata | null;
}

export interface TableHandRecord {
  readonly sessionId: string;
  readonly handNumber: number;
  readonly record: SafeHandRecord;
}

export interface SessionPlayerSummary {
  readonly playerId: PlayerId;
  readonly initialGrants: number;
  readonly replenishments: number;
  readonly hostAdjustments: number;
  readonly finalChipBalance: number;
  readonly netResult: number;
}

export interface NetResultInput {
  readonly finalChips: number;
  readonly initialGrants: number;
  readonly replenishments: number;
  readonly hostAdjustments: number;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly participantPlayerIds: readonly PlayerId[];
  readonly players: readonly SessionPlayerSummary[];
  readonly handCount: number;
  readonly startMetadata: DomainMetadata | null;
  readonly endMetadata: DomainMetadata | null;
}

export interface UncontestedRevealOpportunity {
  readonly sessionId: string;
  readonly handNumber: number;
  readonly hand: OrchestratedHandState;
}

export interface TableState {
  readonly status: TableLifecycleStatus;
  readonly players: readonly TablePlayer[];
  readonly hostPlayerId: PlayerId | null;
  readonly session: ActiveSession | null;
  readonly activeHand: OrchestratedHandState | null;
  readonly uncontestedRevealOpportunity: UncontestedRevealOpportunity | null;
  readonly recentHands: readonly TableHandRecord[];
  readonly recentSessions: readonly SessionSummary[];
}

export interface LedgerEntryDetails {
  readonly ledgerEntryId: string;
  readonly metadata?: DomainMetadata;
}

export interface InitialGrantDetails extends LedgerEntryDetails {
  readonly playerId: PlayerId;
}

export interface EnterTableInput {
  readonly playerId: PlayerId;
  readonly nickname?: string;
  readonly online?: boolean;
  readonly position:
    | { readonly kind: "SPECTATOR" }
    | { readonly kind: "SEAT"; readonly seat: TableSeat };
  readonly initialGrant?: LedgerEntryDetails;
}

export interface SitPlayerInput {
  readonly playerId: PlayerId;
  readonly seat: TableSeat;
  readonly initialGrant?: LedgerEntryDetails;
}

export interface StartSessionInput {
  readonly operatorPlayerId: PlayerId;
  readonly sessionId: string;
  readonly initialGrants: readonly InitialGrantDetails[];
  readonly startMetadata?: DomainMetadata;
}

export interface StartFirstHandInput {
  readonly operatorPlayerId: PlayerId;
  readonly handId: string;
  readonly buttonSeat: TableSeat;
}

export interface StartNextHandInput {
  readonly operatorPlayerId: PlayerId;
  readonly handId: string;
}

export interface SessionEndPreview {
  readonly sessionId: string;
  readonly completedHandCount: number;
  readonly participantPlayerIds: readonly PlayerId[];
  readonly finalChipBalances: Readonly<Record<PlayerId, number>>;
}

export interface EndSessionInput {
  readonly operatorPlayerId: PlayerId;
  readonly confirmation: SessionEndPreview;
  readonly endMetadata?: DomainMetadata;
}

export interface ReplenishPlayerInput extends LedgerEntryDetails {
  readonly playerId: PlayerId;
}

export interface AdjustPlayerChipsInput extends LedgerEntryDetails {
  readonly operatorPlayerId: PlayerId;
  readonly playerId: PlayerId;
  readonly amount: number;
}

export interface ChangeBlindsInput {
  readonly operatorPlayerId: PlayerId;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

export interface TransferHostInput {
  readonly operatorPlayerId: PlayerId;
  readonly targetPlayerId: PlayerId;
}

export interface KickPlayerInput {
  readonly operatorPlayerId: PlayerId;
  readonly targetPlayerId: PlayerId;
}

export type { HandCommand, PlayerId, Seat };
