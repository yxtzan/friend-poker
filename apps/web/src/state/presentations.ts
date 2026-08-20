import type {
  Card,
  PublicTableHandRecord,
  SafeTableProjection,
} from "@friend-poker/shared";

export const STREET_REVEAL_DURATION_MS = 820;

export type StreetRevealStreet = "FLOP" | "TURN" | "RIVER";

export interface StreetRevealPresentation {
  readonly key: string;
  readonly handId: string;
  readonly street: StreetRevealStreet;
  readonly cards: readonly Card[];
}

export function cardKey(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function handRecordKey(hand: PublicTableHandRecord): string {
  return `${hand.sessionId}:${hand.handNumber}:${hand.record.handId}`;
}

function streetForBoardSize(size: number): StreetRevealStreet | null {
  if (size === 3) return "FLOP";
  if (size === 4) return "TURN";
  if (size === 5) return "RIVER";
  return null;
}

export function detectStreetReveal(
  previous: SafeTableProjection | null,
  next: SafeTableProjection,
): StreetRevealPresentation | null {
  if (previous === null || next.version <= previous.version) return null;
  const previousHand = previous.currentHand;
  const nextHand = next.currentHand;
  if (previousHand === null || nextHand === null || previousHand.handId !== nextHand.handId) {
    return null;
  }

  const previousCount = previousHand.board.length;
  const nextCount = nextHand.board.length;
  const isStreetAdvance =
    (previousCount === 0 && nextCount === 3) ||
    (previousCount === 3 && nextCount === 4) ||
    (previousCount === 4 && nextCount === 5);
  if (!isStreetAdvance) return null;

  const street = streetForBoardSize(nextCount);
  if (street === null) return null;
  const cards = nextHand.board.slice(previousCount);
  if (cards.length === 0) return null;
  return {
    key: `${nextHand.handId}:${street}:${cards.map(cardKey).join(",")}`,
    handId: nextHand.handId,
    street,
    cards,
  };
}

export function detectNewlyCompletedHand(
  previous: SafeTableProjection | null,
  next: SafeTableProjection,
): PublicTableHandRecord | null {
  if (previous === null || next.version <= previous.version) return null;
  const previousKeys = new Set(previous.recentHands.map(handRecordKey));
  for (let index = next.recentHands.length - 1; index >= 0; index -= 1) {
    const candidate = next.recentHands[index];
    if (
      candidate !== undefined &&
      !previousKeys.has(handRecordKey(candidate)) &&
      candidate.record.completionReason !== null &&
      candidate.record.settlement !== null
    ) {
      return candidate;
    }
  }
  return null;
}

export function handCategoryLabel(category: number, tiebreakers: readonly number[] = []): string {
  if (category === 8 && tiebreakers[0] === 14) return "皇家同花顺";
  const labels: Record<number, string> = {
    8: "同花顺",
    7: "四条",
    6: "葫芦",
    5: "同花",
    4: "顺子",
    3: "三条",
    2: "两对",
    1: "一对",
    0: "高牌",
  };
  return labels[category] ?? "未知牌型";
}
