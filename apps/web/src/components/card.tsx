import type { Card } from "@friend-poker/shared";

const RANK_LABELS: Record<Card["rank"], string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

const SUIT_SYMBOLS: Record<Card["suit"], string> = {
  c: "♣",
  d: "♦",
  h: "♥",
  s: "♠",
};

export interface PlayingCardProps {
  readonly card: Card | null;
  readonly hidden?: boolean;
  readonly empty?: boolean;
  readonly compact?: boolean;
}

export function PlayingCard({ card, hidden = false, empty = false, compact = false }: PlayingCardProps) {
  if (empty) {
    return (
      <span
        className={`playing-card card-empty${compact ? " card-compact" : ""}`}
        aria-label="尚未发出的公共牌"
      >
        <span aria-hidden="true">·</span>
      </span>
    );
  }
  if (hidden || card === null) {
    return (
      <span className={`playing-card card-back${compact ? " card-compact" : ""}`} aria-label="隐藏底牌">
        <span aria-hidden="true">◆</span>
      </span>
    );
  }

  const suitSymbol = SUIT_SYMBOLS[card.suit];
  const rankLabel = RANK_LABELS[card.rank];
  const color = card.suit === "d" || card.suit === "h" ? "red" : "black";
  return (
    <span
      className={`playing-card card-${color}${compact ? " card-compact" : ""}`}
      aria-label={`${rankLabel}${suitSymbol}`}
    >
      <span className="card-rank">{rankLabel}</span>
      <span className="card-suit" aria-hidden="true">
        {suitSymbol}
      </span>
    </span>
  );
}
