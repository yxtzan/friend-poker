import { HandCategory, Rank, Suit } from "./types.js";
import type { Card, HandRank, Rank as RankValue, Suit as SuitValue } from "./types.js";

const VALID_SUITS = new Set<SuitValue>(Object.values(Suit));
const SUIT_ORDER: Readonly<Record<SuitValue, number>> = Object.freeze({
  [Suit.Clubs]: 0,
  [Suit.Diamonds]: 1,
  [Suit.Hearts]: 2,
  [Suit.Spades]: 3,
});

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`;
}

function validateCards(cards: readonly Card[]): void {
  if (cards.length < 5 || cards.length > 7) {
    throw new RangeError("Hand evaluation requires exactly 5 to 7 cards");
  }

  const seen = new Set<string>();
  for (const card of cards) {
    if (
      !Number.isInteger(card.rank) ||
      card.rank < Rank.Two ||
      card.rank > Rank.Ace ||
      !VALID_SUITS.has(card.suit)
    ) {
      throw new RangeError("Hand contains an invalid card");
    }

    const key = cardKey(card);
    if (seen.has(key)) {
      throw new RangeError("Hand contains duplicate cards");
    }
    seen.add(key);
  }
}

function canonicalCards(cards: readonly Card[]): readonly Card[] {
  return Object.freeze(
    [...cards].sort(
      (left, right) =>
        right.rank - left.rank || SUIT_ORDER[right.suit] - SUIT_ORDER[left.suit],
    ),
  );
}

function makeHandRank(
  category: HandRank["category"],
  tiebreakers: readonly number[],
  cards: readonly Card[],
): HandRank {
  return Object.freeze({
    category,
    tiebreakers: Object.freeze([...tiebreakers]),
    bestFive: canonicalCards(cards),
  });
}

function straightHigh(ranksDescending: readonly number[]): number | undefined {
  const unique = [...new Set(ranksDescending)].sort((left, right) => right - left);
  if (unique.length !== 5) {
    return undefined;
  }

  if (
    unique[0] === Rank.Ace &&
    unique[1] === Rank.Five &&
    unique[2] === Rank.Four &&
    unique[3] === Rank.Three &&
    unique[4] === Rank.Two
  ) {
    return Rank.Five;
  }

  return unique.every((rank, index) => index === 0 || unique[index - 1]! - rank === 1)
    ? unique[0]
    : undefined;
}

function evaluateFive(cards: readonly Card[]): HandRank {
  const ranksDescending = cards.map((card) => card.rank).sort((left, right) => right - left);
  const counts = new Map<RankValue, number>();
  for (const rank of ranksDescending) {
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }

  const groups = [...counts.entries()].sort(
    ([leftRank, leftCount], [rightRank, rightCount]) =>
      rightCount - leftCount || rightRank - leftRank,
  );
  const isFlush = cards.every((card) => card.suit === cards[0]!.suit);
  const highStraightCard = straightHigh(ranksDescending);

  if (isFlush && highStraightCard !== undefined) {
    return makeHandRank(HandCategory.StraightFlush, [highStraightCard], cards);
  }

  if (groups[0]![1] === 4) {
    return makeHandRank(
      HandCategory.FourOfAKind,
      [groups[0]![0], groups[1]![0]],
      cards,
    );
  }

  if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    return makeHandRank(HandCategory.FullHouse, [groups[0]![0], groups[1]![0]], cards);
  }

  if (isFlush) {
    return makeHandRank(HandCategory.Flush, ranksDescending, cards);
  }

  if (highStraightCard !== undefined) {
    return makeHandRank(HandCategory.Straight, [highStraightCard], cards);
  }

  if (groups[0]![1] === 3) {
    const kickers = groups
      .slice(1)
      .map(([rank]) => rank)
      .sort((left, right) => right - left);
    return makeHandRank(HandCategory.ThreeOfAKind, [groups[0]![0], ...kickers], cards);
  }

  if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    const pairs = [groups[0]![0], groups[1]![0]].sort((left, right) => right - left);
    return makeHandRank(HandCategory.TwoPair, [pairs[0]!, pairs[1]!, groups[2]![0]], cards);
  }

  if (groups[0]![1] === 2) {
    const kickers = groups
      .slice(1)
      .map(([rank]) => rank)
      .sort((left, right) => right - left);
    return makeHandRank(HandCategory.OnePair, [groups[0]![0], ...kickers], cards);
  }

  return makeHandRank(HandCategory.HighCard, ranksDescending, cards);
}

function* fiveCardCombinations(cards: readonly Card[]): Generator<readonly Card[]> {
  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            yield [
              cards[first]!,
              cards[second]!,
              cards[third]!,
              cards[fourth]!,
              cards[fifth]!,
            ];
          }
        }
      }
    }
  }
}

function compareCanonicalCards(left: readonly Card[], right: readonly Card[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const rankDifference = left[index]!.rank - right[index]!.rank;
    if (rankDifference !== 0) {
      return Math.sign(rankDifference);
    }

    const suitDifference = SUIT_ORDER[left[index]!.suit] - SUIT_ORDER[right[index]!.suit];
    if (suitDifference !== 0) {
      return Math.sign(suitDifference);
    }
  }
  return 0;
}

export function compareHandRanks(left: HandRank, right: HandRank): number {
  if (left.category !== right.category) {
    return Math.sign(left.category - right.category);
  }

  const length = Math.max(left.tiebreakers.length, right.tiebreakers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.tiebreakers[index] ?? 0) - (right.tiebreakers[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
}

export function evaluateBestHand(cards: readonly Card[]): HandRank {
  validateCards(cards);

  let best: HandRank | undefined;
  for (const combination of fiveCardCombinations(cards)) {
    const candidate = evaluateFive(combination);
    const strength = best === undefined ? 1 : compareHandRanks(candidate, best);
    if (
      strength > 0 ||
      (strength === 0 && best !== undefined && compareCanonicalCards(candidate.bestFive, best.bestFive) > 0)
    ) {
      best = candidate;
    }
  }

  if (best === undefined) {
    throw new Error("No five-card combination could be evaluated");
  }

  return best;
}
