import { PotKind } from "./types.js";
import type {
  ConstructedPot,
  ContributionNormalizationResult,
  NormalizedContribution,
  PlayerAmount,
  PotConstructionResult,
  SettlementParticipant,
} from "./types.js";

function assertChipAmount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function validateParticipants(
  participants: readonly SettlementParticipant[],
): readonly SettlementParticipant[] {
  if (participants.length < 2 || participants.length > 6) {
    throw new RangeError("Pot construction requires between 2 and 6 participants");
  }

  const playerIds = new Set<string>();
  const seats = new Set<number>();
  for (const participant of participants) {
    if (participant.playerId.length === 0 || playerIds.has(participant.playerId)) {
      throw new RangeError("Participant player IDs must be non-empty and unique");
    }
    playerIds.add(participant.playerId);

    if (!Number.isInteger(participant.seat) || participant.seat < 0 || seats.has(participant.seat)) {
      throw new RangeError("Participant seats must be non-negative unique integers");
    }
    seats.add(participant.seat);
    assertChipAmount(participant.totalContribution, "Total contribution");
  }

  return [...participants].sort((left, right) => left.seat - right.seat);
}

function freezePlayerAmounts(amounts: readonly PlayerAmount[]): readonly PlayerAmount[] {
  return Object.freeze(amounts.map((amount) => Object.freeze({ ...amount })));
}

export function normalizeContributions(
  participants: readonly SettlementParticipant[],
): ContributionNormalizationResult {
  const ordered = validateParticipants(participants);
  const amountsDescending = ordered
    .map((participant) => participant.totalContribution)
    .sort((left, right) => right - left);
  const highest = amountsDescending[0] ?? 0;
  const secondHighest = amountsDescending[1] ?? 0;
  const highestCount = amountsDescending.filter((amount) => amount === highest).length;
  const unmatchedAmount = highestCount === 1 ? highest - secondHighest : 0;

  const contributions: readonly NormalizedContribution[] = Object.freeze(
    ordered.map((participant) => {
      const refundAmount =
        unmatchedAmount > 0 && participant.totalContribution === highest ? unmatchedAmount : 0;
      return Object.freeze({
        playerId: participant.playerId,
        originalAmount: participant.totalContribution,
        matchedAmount: participant.totalContribution - refundAmount,
        refundAmount,
      });
    }),
  );
  const refunds = freezePlayerAmounts(
    contributions.map(({ playerId, refundAmount }) => ({ playerId, amount: refundAmount })),
  );
  const totalContribution = contributions.reduce(
    (total, contribution) => total + contribution.originalAmount,
    0,
  );
  const totalRefund = contributions.reduce(
    (total, contribution) => total + contribution.refundAmount,
    0,
  );

  return Object.freeze({
    contributions,
    refunds,
    totalContribution,
    totalRefund,
    totalMatched: totalContribution - totalRefund,
  });
}

export function constructPots(
  participants: readonly SettlementParticipant[],
): PotConstructionResult {
  const ordered = validateParticipants(participants);
  const normalized = normalizeContributions(ordered);
  const contributionByPlayer = new Map(
    normalized.contributions.map((contribution) => [
      contribution.playerId,
      contribution.matchedAmount,
    ]),
  );
  const levels = [
    ...new Set(
      normalized.contributions
        .map((contribution) => contribution.matchedAmount)
        .filter((amount) => amount > 0),
    ),
  ].sort((left, right) => left - right);

  const pots: ConstructedPot[] = [];
  let previousLevel = 0;
  for (const level of levels) {
    const contributors = ordered.filter(
      (participant) => (contributionByPlayer.get(participant.playerId) ?? 0) >= level,
    );
    if (contributors.length < 2) {
      throw new Error("Unmatched contribution was not removed before pot construction");
    }

    const amount = (level - previousLevel) * contributors.length;
    const potIndex = pots.length;
    pots.push(
      Object.freeze({
        potIndex,
        kind: potIndex === 0 ? PotKind.Main : PotKind.Side,
        contributionFrom: previousLevel,
        contributionTo: level,
        amount,
        contributorPlayerIds: Object.freeze(
          contributors.map((participant) => participant.playerId),
        ),
        eligiblePlayerIds: Object.freeze(
          contributors
            .filter((participant) => !participant.folded)
            .map((participant) => participant.playerId),
        ),
      }),
    );
    previousLevel = level;
  }

  const totalPotAmount = pots.reduce((total, pot) => total + pot.amount, 0);
  if (normalized.totalMatched !== totalPotAmount) {
    throw new Error("Pot construction failed contribution conservation");
  }

  return Object.freeze({ ...normalized, pots: Object.freeze(pots) });
}
