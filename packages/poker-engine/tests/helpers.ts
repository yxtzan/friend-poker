import { createDeck, parseCard, shuffleDeck } from "../src/index.js";
import type { Card, RandomSource } from "../src/index.js";

export function cards(notations: string): readonly Card[] {
  return Object.freeze(notations.split(/\s+/u).map(parseCard));
}

export function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`;
}

export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomHand(size: 5 | 6 | 7, rng: RandomSource): readonly Card[] {
  return shuffleDeck(createDeck(), rng).slice(0, size);
}

export function shuffled<T>(values: readonly T[], rng: RandomSource): readonly T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}
