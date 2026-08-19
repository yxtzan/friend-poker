import type { BettingState, HandParticipant, PlayerId, Seat } from "../betting/index.js";
import type { Card, HandRank } from "../types.js";

export interface PlayerAmount {
  readonly playerId: PlayerId;
  readonly amount: number;
}

export interface NormalizedContribution {
  readonly playerId: PlayerId;
  readonly originalAmount: number;
  readonly matchedAmount: number;
  readonly refundAmount: number;
}

export interface ContributionNormalizationResult {
  readonly contributions: readonly NormalizedContribution[];
  readonly refunds: readonly PlayerAmount[];
  readonly totalContribution: number;
  readonly totalRefund: number;
  readonly totalMatched: number;
}

export const PotKind = Object.freeze({
  Main: "MAIN",
  Side: "SIDE",
} as const);

export type PotKind = (typeof PotKind)[keyof typeof PotKind];

export interface ConstructedPot {
  readonly potIndex: number;
  readonly kind: PotKind;
  /** Exclusive lower bound of this contribution slice. */
  readonly contributionFrom: number;
  /** Inclusive contribution level required to fund and contest this slice. */
  readonly contributionTo: number;
  readonly amount: number;
  readonly contributorPlayerIds: readonly PlayerId[];
  readonly eligiblePlayerIds: readonly PlayerId[];
}

export interface PotConstructionResult extends ContributionNormalizationResult {
  readonly pots: readonly ConstructedPot[];
}

export interface SettlementInput {
  readonly state: BettingState;
  readonly board?: readonly Card[];
  readonly holeCards?: Readonly<Record<PlayerId, readonly Card[] | undefined>>;
}

export interface PotPayout extends PlayerAmount {
  readonly oddChips: number;
}

export interface SettledPot extends ConstructedPot {
  readonly winnerPlayerIds: readonly PlayerId[];
  readonly payouts: readonly PotPayout[];
}

export interface EvaluatedHand {
  readonly playerId: PlayerId;
  readonly handRank: HandRank;
}

export interface FinalStack {
  readonly playerId: PlayerId;
  readonly seat: Seat;
  readonly stack: number;
}

export interface HandSettlementResult {
  readonly refunds: readonly PlayerAmount[];
  readonly pots: readonly SettledPot[];
  readonly evaluatedHands: readonly EvaluatedHand[];
  readonly totalPayouts: readonly PlayerAmount[];
  readonly finalStacks: readonly FinalStack[];
  readonly totalContribution: number;
  readonly totalRefund: number;
  readonly totalPotAmount: number;
  readonly totalPotPayout: number;
  readonly totalStartingStacks: number;
  readonly totalFinalStacks: number;
}

export type SettlementParticipant = Pick<
  HandParticipant,
  "playerId" | "seat" | "totalContribution" | "folded"
>;
