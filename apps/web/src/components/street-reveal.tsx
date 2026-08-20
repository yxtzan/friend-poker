import type { StreetRevealPresentation } from "../state/presentations.js";
import { PlayingCard } from "./card.js";

const STREET_LABELS: Record<StreetRevealPresentation["street"], string> = {
  FLOP: "翻牌",
  TURN: "转牌",
  RIVER: "河牌",
};

export function StreetReveal({ presentation }: { readonly presentation: StreetRevealPresentation }) {
  return (
    <div
      className="street-reveal"
      aria-label={`${STREET_LABELS[presentation.street]}公共牌揭示`}
      aria-live="polite"
      data-testid="street-reveal"
    >
      <span className="street-reveal-caption">牌开出来了 · {STREET_LABELS[presentation.street]}</span>
      <div className="street-reveal-cards">
        {presentation.cards.map((card) => (
          <PlayingCard card={card} key={`${card.rank}${card.suit}`} />
        ))}
      </div>
    </div>
  );
}
