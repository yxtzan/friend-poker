import { Rank, Suit } from "./types.js";
import type { Card, Deck, RandomSource } from "./types.js";

const RANK_BY_NOTATION: Readonly<Record<string, Rank>> = Object.freeze({
  "2": Rank.Two,
  "3": Rank.Three,
  "4": Rank.Four,
  "5": Rank.Five,
  "6": Rank.Six,
  "7": Rank.Seven,
  "8": Rank.Eight,
  "9": Rank.Nine,
  T: Rank.Ten,
  J: Rank.Jack,
  Q: Rank.Queen,
  K: Rank.King,
  A: Rank.Ace,
});

const VALID_SUITS = new Set<Suit>(Object.values(Suit));

export function parseCard(notation: string): Card {
  if (!/^[2-9TJQKA][CDHS]$/i.test(notation)) {
    throw new RangeError(`Invalid card notation: ${notation}`);
  }

  const rank = RANK_BY_NOTATION[notation[0]!.toUpperCase()];
  const suit = notation[1]!.toLowerCase() as Suit;

  if (rank === undefined || !VALID_SUITS.has(suit)) {
    throw new RangeError(`Invalid card notation: ${notation}`);
  }

  return Object.freeze({ rank, suit });
}

export function createDeck(): Deck {
  const cards: Card[] = [];

  for (const suit of Object.values(Suit)) {
    for (let rank = Rank.Two; rank <= Rank.Ace; rank += 1) {
      cards.push(Object.freeze({ rank: rank as Rank, suit }));
    }
  }

  return Object.freeze(cards);
}

export function shuffleDeck(deck: Deck, rng: RandomSource): Deck {
  const shuffled = [...deck];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomValue = rng();
    if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
      throw new RangeError("Random source must return a finite number in [0, 1)");
    }

    const swapIndex = Math.floor(randomValue * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }

  return Object.freeze(shuffled);
}
