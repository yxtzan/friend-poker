import type {
  CurrentHandProjection,
  PublicActionRecord,
  SafeTableProjection,
} from "@friend-poker/shared";

export interface LastActionPresentation {
  readonly sequence: number;
  readonly streetLabel: string;
  readonly nickname: string;
  readonly actionLabel: string;
  readonly amount: number | null;
  readonly isAllIn: boolean;
}

const STREET_LABELS: Record<PublicActionRecord["street"], string> = {
  PREFLOP: "翻牌前",
  FLOP: "翻牌",
  TURN: "转牌",
  RIVER: "河牌",
};

function displayNameForId(projection: Pick<SafeTableProjection, "seats" | "spectators">, playerId: string): string {
  const player = projection.seats
    .concat(projection.spectators)
    .find((candidate) => candidate?.playerId === playerId);
  return player?.nickname ?? "玩家";
}

function latestAction(actions: readonly PublicActionRecord[]): PublicActionRecord | null {
  return actions.reduce<PublicActionRecord | null>(
    (latest, candidate) => latest === null || candidate.sequence > latest.sequence ? candidate : latest,
    null,
  );
}

function actionLabel(action: PublicActionRecord): string {
  switch (action.semantic) {
    case "FOLD":
      return "弃牌";
    case "CHECK":
      return "过牌";
    case "CALL":
      return "跟注";
    case "BET":
      return "下注";
    case "RAISE":
      return "加注至";
  }
}

export function getLastActionPresentation(
  projection: Pick<SafeTableProjection, "seats" | "spectators">,
  hand: Pick<CurrentHandProjection, "actions"> | null,
): LastActionPresentation | null {
  const action = hand === null ? null : latestAction(hand.actions);
  if (action === null) return null;

  return Object.freeze({
    sequence: action.sequence,
    streetLabel: STREET_LABELS[action.street],
    nickname: displayNameForId(projection, action.playerId),
    actionLabel: actionLabel(action),
    amount: action.semantic === "FOLD" || action.semantic === "CHECK"
      ? null
      : action.semantic === "RAISE"
        ? action.toContribution
        : action.amountCommitted,
    isAllIn: action.isAllIn,
  });
}
