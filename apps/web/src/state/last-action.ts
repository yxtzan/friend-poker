import type {
  PublicHandParticipant,
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

type LastActionProjection = Pick<
  SafeTableProjection,
  "status" | "session" | "currentHand" | "recentHands" | "seats" | "spectators"
>;

function displayNameForId(
  projection: Pick<SafeTableProjection, "seats" | "spectators">,
  playerId: string,
  historicalParticipants: readonly PublicHandParticipant[] = [],
): string {
  const historicalParticipant = historicalParticipants.find((participant) => participant.playerId === playerId);
  if (historicalParticipant?.nickname !== null && historicalParticipant?.nickname !== undefined) {
    return historicalParticipant.nickname;
  }
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

function presentAction(
  projection: LastActionProjection,
  action: PublicActionRecord,
  historicalParticipants: readonly PublicHandParticipant[] = [],
): LastActionPresentation {
  return Object.freeze({
    sequence: action.sequence,
    streetLabel: STREET_LABELS[action.street],
    nickname: displayNameForId(projection, action.playerId, historicalParticipants),
    actionLabel: actionLabel(action),
    amount: action.semantic === "FOLD" || action.semantic === "CHECK"
      ? null
      : action.semantic === "RAISE"
        ? action.toContribution
        : action.amountCommitted,
    isAllIn: action.isAllIn,
  });
}

export function getLastActionPresentation(
  projection: LastActionProjection,
): LastActionPresentation | null {
  if (projection.currentHand !== null) {
    const action = latestAction(projection.currentHand.actions);
    return action === null ? null : presentAction(projection, action);
  }

  if (projection.status !== "BETWEEN_HANDS" || projection.session === null) return null;
  const completedHand = projection.recentHands.find(
    (candidate) =>
      candidate.sessionId === projection.session?.sessionId &&
      candidate.handNumber === projection.session?.completedHandCount,
  );
  if (completedHand === undefined) return null;
  const action = latestAction(completedHand.record.actions);
  return action === null ? null : presentAction(projection, action, completedHand.record.participants);
}
