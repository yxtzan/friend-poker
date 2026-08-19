import { describe, expect, it } from "vitest";

import { createDeck, parseCard, Rank, shuffleDeck, Suit } from "../src/index.js";
import { cardKey, seededRandom } from "./helpers.js";

describe("card parsing", () => {
  it("parses every supported rank and suit without depending on case", () => {
    expect(parseCard("2c")).toEqual({ rank: Rank.Two, suit: Suit.Clubs });
    expect(parseCard("Td")).toEqual({ rank: Rank.Ten, suit: Suit.Diamonds });
    expect(parseCard("jH")).toEqual({ rank: Rank.Jack, suit: Suit.Hearts });
    expect(parseCard("AS")).toEqual({ rank: Rank.Ace, suit: Suit.Spades });
  });

  it.each(["", "1s", "10s", "A", "Asx", "ZZ", "A♠", " As", "As "])(
    "rejects invalid notation %j",
    (notation) => {
      expect(() => parseCard(notation)).toThrow(RangeError);
    },
  );

  it("returns an immutable card", () => {
    expect(Object.isFrozen(parseCard("As"))).toBe(true);
  });
});

describe("deck", () => {
  it("contains exactly 52 unique cards", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(cardKey))).toHaveLength(52);
  });

  it("contains 13 cards of every suit and four cards of every rank", () => {
    const deck = createDeck();
    for (const suit of Object.values(Suit)) {
      expect(deck.filter((card) => card.suit === suit)).toHaveLength(13);
    }
    for (const rank of Object.values(Rank)) {
      expect(deck.filter((card) => card.rank === rank)).toHaveLength(4);
    }
  });

  it("is deeply immutable at its public boundaries", () => {
    const deck = createDeck();
    expect(Object.isFrozen(deck)).toBe(true);
    expect(deck.every(Object.isFrozen)).toBe(true);
  });

  it("shuffles deterministically with an injected seeded RNG", () => {
    const first = shuffleDeck(createDeck(), seededRandom(0xc0ffee));
    const second = shuffleDeck(createDeck(), seededRandom(0xc0ffee));
    const different = shuffleDeck(createDeck(), seededRandom(0xdecafbad));

    expect(first.map(cardKey)).toEqual(second.map(cardKey));
    expect(first.map(cardKey)).not.toEqual(different.map(cardKey));
  });

  it("does not mutate or change the membership of the source deck", () => {
    const deck = createDeck();
    const before = deck.map(cardKey);
    const shuffled = shuffleDeck(deck, seededRandom(42));

    expect(deck.map(cardKey)).toEqual(before);
    expect([...shuffled].map(cardKey).sort()).toEqual([...before].sort());
    expect(Object.isFrozen(shuffled)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1])(
    "rejects an invalid RNG result %s",
    (value) => {
      expect(() => shuffleDeck(createDeck(), () => value)).toThrow(RangeError);
    },
  );
});
