export const Rank = Object.freeze({
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
  Ten: 10,
  Jack: 11,
  Queen: 12,
  King: 13,
  Ace: 14,
} as const);

export type Rank = (typeof Rank)[keyof typeof Rank];

export const Suit = Object.freeze({
  Clubs: "c",
  Diamonds: "d",
  Hearts: "h",
  Spades: "s",
} as const);

export type Suit = (typeof Suit)[keyof typeof Suit];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

export type Deck = readonly Card[];

export const HandCategory = Object.freeze({
  HighCard: 0,
  OnePair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
} as const);

export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

export interface HandRank {
  readonly category: HandCategory;
  readonly tiebreakers: readonly number[];
  readonly bestFive: readonly Card[];
}

export type RandomSource = () => number;
