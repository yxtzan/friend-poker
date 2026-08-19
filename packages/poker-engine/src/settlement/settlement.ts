import { BettingStatus } from "../betting/index.js";
import type { BettingState, HandParticipant, PlayerId } from "../betting/index.js";
import { compareHandRanks, evaluateBestHand } from "../hand-evaluator.js";
import { Rank, Suit } from "../types.js";
import type { Card, HandRank, Rank as RankValue, Suit as SuitValue } from "../types.js";
import { SettlementRuleError } from "./errors.js";
import { constructPots } from "./pot-construction.js";
import type {
  EvaluatedHand,
  FinalStack,
  HandSettlementResult,
  PlayerAmount,
  PotPayout,
  SettledPot,
  SettlementInput,
} from "./types.js";

const VALID_RANKS = new Set<RankValue>(Object.values(Rank));
const VALID_SUITS = new Set<SuitValue>(Object.values(Suit));

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function validateState(state: BettingState): void {
  if (state.status === BettingStatus.Betting || state.currentActorId !== null) {
    throw new SettlementRuleError("Settlement requires a betting-complete hand state");
  }
  if (state.participants.length < 2 || state.participants.length > 6) {
    throw new SettlementRuleError("Settlement requires between 2 and 6 participants");
  }

  const playerIds = new Set<PlayerId>();
  const seats = new Set<number>();
  for (const participant of state.participants) {
    if (participant.playerId.length === 0 || playerIds.has(participant.playerId)) {
      throw new SettlementRuleError("Participant player IDs must be non-empty and unique");
    }
    playerIds.add(participant.playerId);
    if (!Number.isInteger(participant.seat) || participant.seat < 0 || seats.has(participant.seat)) {
      throw new SettlementRuleError("Participant seats must be non-negative unique integers");
    }
    seats.add(participant.seat);
    if (
      !Number.isInteger(participant.startingStack) ||
      participant.startingStack < 1 ||
      !Number.isInteger(participant.stack) ||
      participant.stack < 0 ||
      !Number.isInteger(participant.totalContribution) ||
      participant.totalContribution < 0 ||
      participant.stack + participant.totalContribution !== participant.startingStack
    ) {
      throw new SettlementRuleError(`Invalid chip state for ${participant.playerId}`);
    }
  }

  if (!seats.has(state.buttonSeat)) {
    throw new SettlementRuleError("Button seat must belong to a hand participant");
  }
  const contenders = state.participants.filter((participant) => !participant.folded);
  if (contenders.length === 0) {
    throw new SettlementRuleError("At least one non-folded contender is required");
  }
  if (
    state.status === BettingStatus.Uncontested &&
    (contenders.length !== 1 || state.uncontestedWinnerId !== contenders[0]!.playerId)
  ) {
    throw new SettlementRuleError("Uncontested state must identify its sole contender");
  }
}

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`;
}

function validateCard(card: Card): void {
  if (!VALID_RANKS.has(card.rank) || !VALID_SUITS.has(card.suit)) {
    throw new SettlementRuleError("Showdown contains an invalid card");
  }
}

function evaluateRequiredHands(
  input: SettlementInput,
  requiredPlayerIds: ReadonlySet<PlayerId>,
): ReadonlyMap<PlayerId, HandRank> {
  if (requiredPlayerIds.size === 0) {
    return new Map<PlayerId, HandRank>();
  }
  if (input.board === undefined || input.board.length !== 5) {
    throw new SettlementRuleError("Showdown comparison requires exactly five board cards");
  }
  if (input.holeCards === undefined) {
    throw new SettlementRuleError("Showdown comparison requires hole cards");
  }

  const participantsById = new Map(
    input.state.participants.map((participant) => [participant.playerId, participant]),
  );
  const suppliedHoleCards = Object.entries(input.holeCards);
  const seenCards = new Set<string>();
  for (const card of input.board) {
    validateCard(card);
    const key = cardKey(card);
    if (seenCards.has(key)) {
      throw new SettlementRuleError("Showdown contains duplicate cards");
    }
    seenCards.add(key);
  }

  for (const [playerId, cards] of suppliedHoleCards) {
    if (!participantsById.has(playerId)) {
      throw new SettlementRuleError(`Hole cards supplied for unknown player ${playerId}`);
    }
    if (cards === undefined || cards.length !== 2) {
      throw new SettlementRuleError(`Player ${playerId} must have exactly two hole cards`);
    }
    for (const card of cards) {
      validateCard(card);
      const key = cardKey(card);
      if (seenCards.has(key)) {
        throw new SettlementRuleError("Showdown contains duplicate cards");
      }
      seenCards.add(key);
    }
  }

  const ranks = new Map<PlayerId, HandRank>();
  for (const playerId of requiredPlayerIds) {
    const participant = participantsById.get(playerId);
    if (participant === undefined || participant.folded) {
      throw new SettlementRuleError("Folded or unknown player cannot require hand comparison");
    }
    const holeCards = input.holeCards[playerId];
    if (holeCards === undefined || holeCards.length !== 2) {
      throw new SettlementRuleError(`Player ${playerId} must have exactly two hole cards`);
    }
    ranks.set(playerId, evaluateBestHand([...input.board, ...holeCards]));
  }
  return ranks;
}

function clockwiseWinners(
  winnerIds: ReadonlySet<PlayerId>,
  participants: readonly HandParticipant[],
  buttonSeat: number,
): readonly PlayerId[] {
  const winners = participants
    .filter((participant) => winnerIds.has(participant.playerId))
    .sort((left, right) => left.seat - right.seat);
  const firstAfterButton = winners.findIndex((participant) => participant.seat > buttonSeat);
  const rotation = firstAfterButton === -1 ? 0 : firstAfterButton;
  return Object.freeze(
    [...winners.slice(rotation), ...winners.slice(0, rotation)].map(
      (participant) => participant.playerId,
    ),
  );
}

function determineWinners(
  eligiblePlayerIds: readonly PlayerId[],
  handRanks: ReadonlyMap<PlayerId, HandRank>,
): ReadonlySet<PlayerId> {
  if (eligiblePlayerIds.length === 1) {
    return new Set([eligiblePlayerIds[0]!]);
  }

  let bestRank: HandRank | undefined;
  const winners = new Set<PlayerId>();
  for (const playerId of eligiblePlayerIds) {
    const rank = handRanks.get(playerId);
    if (rank === undefined) {
      throw new SettlementRuleError(`Missing evaluated hand for ${playerId}`);
    }
    const comparison = bestRank === undefined ? 1 : compareHandRanks(rank, bestRank);
    if (comparison > 0) {
      bestRank = rank;
      winners.clear();
      winners.add(playerId);
    } else if (comparison === 0) {
      winners.add(playerId);
    }
  }
  return winners;
}

function settlePotAmount(
  amount: number,
  orderedWinnerIds: readonly PlayerId[],
): readonly PotPayout[] {
  const baseShare = Math.floor(amount / orderedWinnerIds.length);
  const remainder = amount % orderedWinnerIds.length;
  return Object.freeze(
    orderedWinnerIds.map((playerId, index) =>
      Object.freeze({
        playerId,
        amount: baseShare + (index < remainder ? 1 : 0),
        oddChips: index < remainder ? 1 : 0,
      }),
    ),
  );
}

function freezePlayerAmounts(amounts: readonly PlayerAmount[]): readonly PlayerAmount[] {
  return Object.freeze(amounts.map((amount) => Object.freeze({ ...amount })));
}

export function settleHand(input: SettlementInput): HandSettlementResult {
  validateState(input.state);
  const construction = constructPots(input.state.participants);
  for (const pot of construction.pots) {
    if (pot.eligiblePlayerIds.length === 0) {
      throw new SettlementRuleError(`Pot ${pot.potIndex} has no eligible winner`);
    }
  }

  const comparisonPlayerIds = new Set<PlayerId>();
  for (const pot of construction.pots) {
    if (pot.eligiblePlayerIds.length > 1) {
      for (const playerId of pot.eligiblePlayerIds) comparisonPlayerIds.add(playerId);
    }
  }
  const handRanks = evaluateRequiredHands(input, comparisonPlayerIds);
  const evaluatedHands: readonly EvaluatedHand[] = Object.freeze(
    input.state.participants
      .filter((participant) => handRanks.has(participant.playerId))
      .map((participant) =>
        Object.freeze({
          playerId: participant.playerId,
          handRank: handRanks.get(participant.playerId)!,
        }),
      ),
  );

  const payoutByPlayer = new Map<PlayerId, number>(
    input.state.participants.map((participant) => [participant.playerId, 0]),
  );
  const settledPots: SettledPot[] = construction.pots.map((pot) => {
    const winnerSet = determineWinners(pot.eligiblePlayerIds, handRanks);
    const winnerPlayerIds = clockwiseWinners(
      winnerSet,
      input.state.participants,
      input.state.buttonSeat,
    );
    const payouts = settlePotAmount(pot.amount, winnerPlayerIds);
    for (const payout of payouts) {
      payoutByPlayer.set(payout.playerId, (payoutByPlayer.get(payout.playerId) ?? 0) + payout.amount);
    }
    return Object.freeze({ ...pot, winnerPlayerIds, payouts });
  });

  const refundByPlayer = new Map(
    construction.refunds.map((refund) => [refund.playerId, refund.amount]),
  );
  const totalPayouts = freezePlayerAmounts(
    input.state.participants.map((participant) => ({
      playerId: participant.playerId,
      amount: payoutByPlayer.get(participant.playerId) ?? 0,
    })),
  );
  const finalStacks: readonly FinalStack[] = Object.freeze(
    input.state.participants.map((participant) =>
      Object.freeze({
        playerId: participant.playerId,
        seat: participant.seat,
        stack:
          participant.stack +
          (refundByPlayer.get(participant.playerId) ?? 0) +
          (payoutByPlayer.get(participant.playerId) ?? 0),
      }),
    ),
  );

  const totalPotAmount = sum(settledPots.map((pot) => pot.amount));
  const totalPotPayout = sum(
    settledPots.flatMap((pot) => pot.payouts.map((payout) => payout.amount)),
  );
  const totalStartingStacks = sum(
    input.state.participants.map((participant) => participant.startingStack),
  );
  const totalFinalStacks = sum(finalStacks.map((participant) => participant.stack));
  if (
    construction.totalContribution !== construction.totalRefund + totalPotAmount ||
    totalPotAmount !== totalPotPayout ||
    totalStartingStacks !== totalFinalStacks ||
    finalStacks.some((participant) => participant.stack < 0)
  ) {
    throw new Error("Settlement failed chip conservation");
  }

  return Object.freeze({
    refunds: construction.refunds,
    pots: Object.freeze(settledPots),
    evaluatedHands,
    totalPayouts,
    finalStacks,
    totalContribution: construction.totalContribution,
    totalRefund: construction.totalRefund,
    totalPotAmount,
    totalPotPayout,
    totalStartingStacks,
    totalFinalStacks,
  });
}
