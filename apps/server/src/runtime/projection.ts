import { legalActions, TABLE_SEAT_COUNT } from "@friend-poker/poker-engine";
import type {
  Card,
  ChipLedgerEntry,
  HandActionEvent,
  OrchestratedHandState,
  SessionSummary,
  TablePlayer,
  TableState,
} from "@friend-poker/poker-engine";
import type {
  CurrentHandProjection,
  PublicLedgerEntryProjection,
  PublicPlayerProjection,
  PublicSessionSummary,
  SafeTableProjection,
  SessionProjection,
  TableViewer,
  ViewerLegalActions,
} from "./types.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function safeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function copyCard(card: Card): Card {
  return Object.freeze({ rank: card.rank, suit: card.suit });
}

function projectPlayer(player: TablePlayer): PublicPlayerProjection {
  return Object.freeze({
    playerId: player.playerId,
    nickname: player.nickname,
    seat: player.seat,
    present: player.present,
    online: player.online,
    pendingLeaveAfterHand: player.pendingLeaveAfterHand,
    chipBalance: player.chipBalance,
  });
}

function projectLedgerEntry(entry: ChipLedgerEntry): PublicLedgerEntryProjection {
  return Object.freeze({
    ledgerEntryId: entry.ledgerEntryId,
    sessionId: entry.sessionId,
    playerId: entry.playerId,
    amount: entry.amount,
    type: entry.type,
    operatorPlayerId: entry.operatorPlayerId,
    sequence: entry.sequence,
  });
}

function projectSessionSummary(summary: SessionSummary): PublicSessionSummary {
  return Object.freeze({
    sessionId: summary.sessionId,
    participantPlayerIds: Object.freeze([...summary.participantPlayerIds]),
    players: Object.freeze(summary.players.map((player) => Object.freeze({ ...player }))),
    handCount: summary.handCount,
  });
}

function projectSession(state: TableState): SessionProjection | null {
  if (state.session === null) return null;
  return Object.freeze({
    sessionId: state.session.sessionId,
    blinds: Object.freeze({ ...state.session.blinds }),
    completedHandCount: state.session.completedHandCount,
    lastButtonSeat: state.session.lastButtonSeat,
    ledger: Object.freeze(state.session.ledger.map(projectLedgerEntry)),
  });
}

function projectCurrentHand(hand: OrchestratedHandState | null): CurrentHandProjection | null {
  if (hand === null) return null;
  const actions = hand.events.filter(
    (event): event is HandActionEvent => event.type === "ACTION",
  );
  return Object.freeze({
    handId: hand.handId,
    status: hand.status,
    participants: Object.freeze(
      hand.bettingState.participants.map((participant) =>
        Object.freeze({
          playerId: participant.playerId,
          seat: participant.seat,
          startingStack: participant.startingStack,
          stack: participant.stack,
          streetContribution: participant.streetContribution,
          totalContribution: participant.totalContribution,
          folded: participant.folded,
          allIn: participant.allIn,
        }),
      ),
    ),
    buttonSeat: hand.bettingState.buttonSeat,
    smallBlindSeat: hand.bettingState.smallBlindSeat,
    bigBlindSeat: hand.bettingState.bigBlindSeat,
    smallBlind: hand.bettingState.smallBlind,
    bigBlind: hand.bettingState.bigBlind,
    street: hand.bettingState.street,
    currentActorId: hand.bettingState.currentActorId,
    currentBet: hand.bettingState.currentBet,
    potSize: hand.bettingState.participants.reduce(
      (total, participant) => total + participant.totalContribution,
      0,
    ),
    board: Object.freeze(hand.board.map(copyCard)),
    actions: Object.freeze(actions.map((action) => Object.freeze({ ...action }))),
  });
}

function projectOwnCards(
  hand: OrchestratedHandState | null,
  viewer: TableViewer,
): readonly [Card, Card] | null {
  if (hand === null || viewer.kind !== "PLAYER") return null;
  const ownHand = hand.privateHoleCards.find(
    (candidate) => candidate.playerId === viewer.playerId,
  );
  if (ownHand === undefined) return null;
  return Object.freeze([copyCard(ownHand.cards[0]), copyCard(ownHand.cards[1])] as const);
}

function projectViewerLegalActions(
  hand: OrchestratedHandState | null,
  viewer: TableViewer,
): ViewerLegalActions | null {
  if (
    hand === null ||
    viewer.kind !== "PLAYER" ||
    hand.bettingState.status !== "BETTING" ||
    hand.bettingState.currentActorId !== viewer.playerId
  ) {
    return null;
  }

  const legal = legalActions(hand.bettingState);
  return Object.freeze({
    playerId: legal.playerId,
    canFold: legal.canFold,
    canCheck: legal.canCheck,
    canCall: legal.canCall,
    callAmount: legal.callAmount,
    callIsAllIn: legal.callIsAllIn,
    canBet: legal.canBet,
    minimumBet: legal.minimumBet,
    maximumBet: legal.maximumBet,
    canRaise: legal.canRaise,
    minimumRaiseTo: legal.minimumRaiseTo,
    maximumRaiseTo: legal.maximumRaiseTo,
    raiseRightsOpen: legal.raiseRightsOpen,
    canAllIn: legal.canAllIn,
    allInTo: legal.allInTo,
  });
}

export function projectTableState(
  state: TableState,
  version: number,
  viewer: TableViewer,
): SafeTableProjection {
  const seats = Array.from({ length: TABLE_SEAT_COUNT }, (_, seat) => {
    const player = state.players.find((candidate) => candidate.seat === seat);
    return player === undefined ? null : projectPlayer(player);
  });
  const spectators = state.players
    .filter((player) => player.present && player.seat === null)
    .map(projectPlayer);
  return deepFreeze({
    version,
    status: state.status,
    hostPlayerId: state.hostPlayerId,
    seats,
    spectators,
    session: projectSession(state),
    currentHand: projectCurrentHand(state.activeHand),
    viewerLegalActions: projectViewerLegalActions(state.activeHand, viewer),
    viewerCanRevealUncontested:
      viewer.kind === "PLAYER" &&
      state.uncontestedRevealOpportunity?.hand.bettingState.uncontestedWinnerId === viewer.playerId &&
      !state.uncontestedRevealOpportunity.hand.revealedHoleCards.some(
        (hand) => hand.playerId === viewer.playerId,
      ),
    ownHoleCards: projectOwnCards(state.activeHand, viewer),
    recentHands: state.recentHands.map((record) => safeClone(record)),
    recentSessions: state.recentSessions.map(projectSessionSummary),
  });
}
