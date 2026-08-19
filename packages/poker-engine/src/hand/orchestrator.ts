import { createDeck, shuffleDeck } from "../cards.js";
import {
  administrativelyFold,
  applyAction,
  BettingStatus,
  createBettingState,
  nextEligibleSeat,
  Street,
} from "../betting/index.js";
import type {
  BettingActionRecord,
  BettingState,
  PlayerId,
  Seat,
} from "../betting/index.js";
import { settleHand } from "../settlement/index.js";
import type { Card, Deck, RandomSource } from "../types.js";
import { HandOrchestrationError } from "./errors.js";
import {
  HandCompletionReason,
  HandLifecycleStatus,
  HoleCardRevealReason,
} from "./types.js";
import type {
  AdministrativeFoldEvent,
  AdministrativeFoldInput,
  BoardRevealEvent,
  HandActionEvent,
  HandCommand,
  HandEvent,
  HandSettledEvent,
  HoleCardsRevealEvent,
  OrchestratedHandState,
  PrivateHoleCards,
  RevealedHoleCards,
  SafeHandRecord,
  StartHandInput,
} from "./types.js";

function freezeCards(cards: readonly Card[]): readonly Card[] {
  return Object.freeze([...cards]);
}

function freezePrivateHand(hand: PrivateHoleCards): PrivateHoleCards {
  return Object.freeze({
    playerId: hand.playerId,
    cards: Object.freeze([hand.cards[0], hand.cards[1]] as const),
  });
}

function freezeRevealedHand(hand: RevealedHoleCards): RevealedHoleCards {
  return Object.freeze({
    playerId: hand.playerId,
    cards: Object.freeze([hand.cards[0], hand.cards[1]] as const),
    reason: hand.reason,
  });
}

function freezeEvent(event: HandEvent): HandEvent {
  switch (event.type) {
    case "ACTION":
    case "ADMINISTRATIVE_FOLD":
      return Object.freeze({ ...event });
    case "BOARD_REVEALED":
      return Object.freeze({ ...event, cards: freezeCards(event.cards) });
    case "HOLE_CARDS_REVEALED":
      return Object.freeze({
        ...event,
        hands: Object.freeze(event.hands.map(freezeRevealedHand)),
      });
    case "HAND_SETTLED":
      return Object.freeze({ ...event });
  }
}

function freezeState(state: OrchestratedHandState): OrchestratedHandState {
  return Object.freeze({
    ...state,
    remainingDeck: Object.freeze([...state.remainingDeck]),
    privateHoleCards: Object.freeze(state.privateHoleCards.map(freezePrivateHand)),
    board: freezeCards(state.board),
    events: Object.freeze(state.events.map(freezeEvent)),
    revealedHoleCards: Object.freeze(state.revealedHoleCards.map(freezeRevealedHand)),
  });
}

function clockwiseDealOrder(buttonSeat: Seat, seats: readonly Seat[]): readonly Seat[] {
  const order: Seat[] = [];
  let seat = buttonSeat;
  while (order.length < seats.length) {
    seat = nextEligibleSeat(seat, seats);
    order.push(seat);
  }
  return order;
}

function dealHoleCards(
  deck: Deck,
  bettingState: BettingState,
): { readonly hands: readonly PrivateHoleCards[]; readonly remainingDeck: Deck } {
  const seatOrder = clockwiseDealOrder(
    bettingState.buttonSeat,
    bettingState.participants.map((participant) => participant.seat),
  );
  const cardsByPlayer = new Map<PlayerId, Card[]>();
  let cursor = 0;
  for (let round = 0; round < 2; round += 1) {
    for (const seat of seatOrder) {
      const participant = bettingState.participants.find((candidate) => candidate.seat === seat)!;
      const card = deck[cursor];
      if (card === undefined) throw new Error("Deck exhausted while dealing hole cards");
      const cards = cardsByPlayer.get(participant.playerId) ?? [];
      cards.push(card);
      cardsByPlayer.set(participant.playerId, cards);
      cursor += 1;
    }
  }

  const hands = seatOrder.map((seat) => {
    const participant = bettingState.participants.find((candidate) => candidate.seat === seat)!;
    const cards = cardsByPlayer.get(participant.playerId)!;
    return freezePrivateHand({
      playerId: participant.playerId,
      cards: [cards[0]!, cards[1]!],
    });
  });
  return Object.freeze({
    hands: Object.freeze(hands),
    remainingDeck: Object.freeze(deck.slice(cursor)),
  });
}

function lifecycleStatus(bettingState: BettingState): OrchestratedHandState["status"] {
  if (bettingState.status === BettingStatus.Betting) return HandLifecycleStatus.Betting;
  if (bettingState.status === BettingStatus.RunoutRequired) {
    return HandLifecycleStatus.RunoutRequired;
  }
  throw new HandOrchestrationError("Betting state requires immediate settlement");
}

function actionEvent(
  action: BettingActionRecord,
  street: BettingState["street"],
  sequence: number,
): HandActionEvent {
  return Object.freeze({ ...action, type: "ACTION", street, sequence });
}

function revealBoardStage(
  board: readonly Card[],
  remainingDeck: Deck,
  events: readonly HandEvent[],
): {
  readonly board: readonly Card[];
  readonly remainingDeck: Deck;
  readonly events: readonly HandEvent[];
} {
  let count: number;
  let street: BoardRevealEvent["street"];
  if (board.length === 0) {
    count = 3;
    street = Street.Flop;
  } else if (board.length === 3) {
    count = 1;
    street = Street.Turn;
  } else if (board.length === 4) {
    count = 1;
    street = Street.River;
  } else {
    throw new HandOrchestrationError("Board is not at a revealable stage");
  }

  const revealed = remainingDeck.slice(0, count);
  if (revealed.length !== count) throw new Error("Deck exhausted while revealing the board");
  const event: BoardRevealEvent = Object.freeze({
    type: "BOARD_REVEALED",
    sequence: events.length,
    street,
    cards: freezeCards(revealed),
  });
  return Object.freeze({
    board: freezeCards([...board, ...revealed]),
    remainingDeck: Object.freeze(remainingDeck.slice(count)),
    events: Object.freeze([...events, event]),
  });
}

function revealForStreetTransition(
  previousStreet: BettingState["street"],
  nextStreet: BettingState["street"],
  board: readonly Card[],
  remainingDeck: Deck,
  events: readonly HandEvent[],
) {
  const expected =
    previousStreet === Street.Preflop
      ? Street.Flop
      : previousStreet === Street.Flop
        ? Street.Turn
        : previousStreet === Street.Turn
          ? Street.River
          : null;
  if (expected !== nextStreet) {
    throw new Error("Betting engine produced an invalid street transition");
  }
  return revealBoardStage(board, remainingDeck, events);
}

function privateHandsForContenders(
  state: OrchestratedHandState,
): Readonly<Record<PlayerId, readonly Card[]>> {
  const contenderIds = new Set(
    state.bettingState.participants
      .filter((participant) => !participant.folded)
      .map((participant) => participant.playerId),
  );
  return Object.freeze(
    Object.fromEntries(
      state.privateHoleCards
        .filter((hand) => contenderIds.has(hand.playerId))
        .map((hand) => [hand.playerId, hand.cards]),
    ),
  );
}

function completeHand(
  state: OrchestratedHandState,
  reason: OrchestratedHandState["completionReason"] & {},
): OrchestratedHandState {
  if (state.settlement !== null || state.status === HandLifecycleStatus.Complete) {
    throw new HandOrchestrationError("Hand has already been settled");
  }

  const isShowdown = reason === HandCompletionReason.Showdown;
  const contenderHoleCards = isShowdown ? privateHandsForContenders(state) : null;
  const settlement =
    contenderHoleCards === null
      ? settleHand({ state: state.bettingState })
      : settleHand({
          state: state.bettingState,
          board: state.board,
          holeCards: contenderHoleCards,
        });
  const events = [...state.events];
  let revealedHoleCards: readonly RevealedHoleCards[] = state.revealedHoleCards;

  if (isShowdown) {
    revealedHoleCards = Object.freeze(
      state.privateHoleCards
        .filter((hand) => contenderHoleCards?.[hand.playerId] !== undefined)
        .map((hand) =>
          freezeRevealedHand({ ...hand, reason: HoleCardRevealReason.Showdown }),
        ),
    );
    const revealEvent: HoleCardsRevealEvent = Object.freeze({
      type: "HOLE_CARDS_REVEALED",
      sequence: events.length,
      reason: HoleCardRevealReason.Showdown,
      hands: revealedHoleCards,
    });
    events.push(revealEvent);
  }

  const settledEvent: HandSettledEvent = Object.freeze({
    type: "HAND_SETTLED",
    sequence: events.length,
    reason,
  });
  events.push(settledEvent);
  return freezeState({
    ...state,
    status: HandLifecycleStatus.Complete,
    completionReason: reason,
    events: Object.freeze(events),
    revealedHoleCards,
    settlement,
  });
}

function settleIfRequired(state: OrchestratedHandState): OrchestratedHandState {
  if (state.bettingState.status === BettingStatus.Uncontested) {
    return completeHand(state, HandCompletionReason.Uncontested);
  }
  if (state.bettingState.status === BettingStatus.ShowdownPending) {
    if (state.board.length !== 5) {
      throw new HandOrchestrationError("Showdown requires a complete five-card board");
    }
    return completeHand(state, HandCompletionReason.Showdown);
  }
  return state;
}

export function startHand(input: StartHandInput, rng: RandomSource): OrchestratedHandState {
  if (input.handId.length === 0) {
    throw new RangeError("Hand ID must not be empty");
  }
  const bettingState = createBettingState({
    participants: input.participants,
    buttonSeat: input.buttonSeat,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
  });
  const shuffledDeck = shuffleDeck(createDeck(), rng);
  const dealt = dealHoleCards(shuffledDeck, bettingState);
  const state = freezeState({
    handId: input.handId,
    status: lifecycleStatus(bettingState),
    completionReason: null,
    bettingState,
    remainingDeck: dealt.remainingDeck,
    privateHoleCards: dealt.hands,
    board: Object.freeze([]),
    events: Object.freeze([]),
    revealedHoleCards: Object.freeze([]),
    settlement: null,
  });
  return settleIfRequired(state);
}

export function applyHandAction(
  state: OrchestratedHandState,
  command: HandCommand,
): OrchestratedHandState {
  if (
    state.status !== HandLifecycleStatus.Betting ||
    state.bettingState.status !== BettingStatus.Betting
  ) {
    throw new HandOrchestrationError("Hand is not waiting for a player action");
  }

  const previousStreet = state.bettingState.street;
  const bettingState = applyAction(state.bettingState, command);
  if (bettingState.lastAction === null) {
    throw new Error("Betting engine did not record the applied action");
  }
  let board = state.board;
  let remainingDeck = state.remainingDeck;
  let events: readonly HandEvent[] = Object.freeze([
    ...state.events,
    actionEvent(bettingState.lastAction, previousStreet, state.events.length),
  ]);

  if (bettingState.street !== previousStreet) {
    const reveal = revealForStreetTransition(
      previousStreet,
      bettingState.street,
      board,
      remainingDeck,
      events,
    );
    board = reveal.board;
    remainingDeck = reveal.remainingDeck;
    events = reveal.events;
  }

  const next = freezeState({
    ...state,
    status:
      bettingState.status === BettingStatus.Betting
        ? HandLifecycleStatus.Betting
        : bettingState.status === BettingStatus.RunoutRequired
          ? HandLifecycleStatus.RunoutRequired
          : state.status,
    bettingState,
    board,
    remainingDeck,
    events,
  });
  return settleIfRequired(next);
}

export function administrativelyFoldHandParticipant(
  state: OrchestratedHandState,
  input: AdministrativeFoldInput,
): OrchestratedHandState {
  if (
    (state.status !== HandLifecycleStatus.Betting &&
      state.status !== HandLifecycleStatus.RunoutRequired) ||
    (state.bettingState.status !== BettingStatus.Betting &&
      state.bettingState.status !== BettingStatus.RunoutRequired)
  ) {
    throw new HandOrchestrationError("Hand is not waiting for an administrative Fold");
  }
  const bettingState = administrativelyFold(state.bettingState, input.targetPlayerId);
  const event: AdministrativeFoldEvent = Object.freeze({
    type: "ADMINISTRATIVE_FOLD",
    sequence: state.events.length,
    handId: state.handId,
    targetPlayerId: input.targetPlayerId,
    reason: input.reason,
    operatorPlayerId: input.operatorPlayerId,
  });
  const next = freezeState({
    ...state,
    status:
      bettingState.status === BettingStatus.Betting
        ? HandLifecycleStatus.Betting
        : bettingState.status === BettingStatus.RunoutRequired
          ? HandLifecycleStatus.RunoutRequired
          : state.status,
    bettingState,
    events: Object.freeze([...state.events, event]),
  });
  return settleIfRequired(next);
}

export function advanceRunout(state: OrchestratedHandState): OrchestratedHandState {
  if (
    state.status !== HandLifecycleStatus.RunoutRequired ||
    state.bettingState.status !== BettingStatus.RunoutRequired
  ) {
    throw new HandOrchestrationError("Runout is not currently required");
  }

  const reveal = revealBoardStage(state.board, state.remainingDeck, state.events);
  const next = freezeState({
    ...state,
    board: reveal.board,
    remainingDeck: reveal.remainingDeck,
    events: reveal.events,
  });
  return next.board.length === 5
    ? completeHand(next, HandCompletionReason.Showdown)
    : next;
}

export function revealUncontestedWinner(
  state: OrchestratedHandState,
  playerId: PlayerId,
): OrchestratedHandState {
  if (
    state.status !== HandLifecycleStatus.Complete ||
    state.completionReason !== HandCompletionReason.Uncontested ||
    state.bettingState.uncontestedWinnerId !== playerId
  ) {
    throw new HandOrchestrationError("Only the completed uncontested winner may reveal");
  }
  if (state.revealedHoleCards.some((hand) => hand.playerId === playerId)) return state;

  const privateHand = state.privateHoleCards.find((hand) => hand.playerId === playerId);
  if (privateHand === undefined) throw new Error("Winner's private cards are missing");
  const revealed = freezeRevealedHand({
    ...privateHand,
    reason: HoleCardRevealReason.VoluntaryUncontested,
  });
  const revealEvent: HoleCardsRevealEvent = Object.freeze({
    type: "HOLE_CARDS_REVEALED",
    sequence: state.events.length,
    reason: HoleCardRevealReason.VoluntaryUncontested,
    hands: Object.freeze([revealed]),
  });
  return freezeState({
    ...state,
    events: Object.freeze([...state.events, revealEvent]),
    revealedHoleCards: Object.freeze([revealed]),
  });
}

export function getHandRecord(state: OrchestratedHandState): SafeHandRecord {
  const actions = state.events.filter(
    (event): event is HandActionEvent => event.type === "ACTION",
  );
  return Object.freeze({
    handId: state.handId,
    participants: Object.freeze(
      state.bettingState.participants.map((participant) =>
        Object.freeze({
          playerId: participant.playerId,
          seat: participant.seat,
          startingStack: participant.startingStack,
        }),
      ),
    ),
    buttonSeat: state.bettingState.buttonSeat,
    smallBlindSeat: state.bettingState.smallBlindSeat,
    bigBlindSeat: state.bettingState.bigBlindSeat,
    smallBlind: state.bettingState.smallBlind,
    bigBlind: state.bettingState.bigBlind,
    actions: Object.freeze(actions.map((action) => Object.freeze({ ...action }))),
    board: freezeCards(state.board),
    flop: freezeCards(state.board.slice(0, 3)),
    turn: state.board[3] ?? null,
    river: state.board[4] ?? null,
    events: Object.freeze(state.events.map(freezeEvent)),
    completionReason: state.completionReason,
    settlement: state.settlement,
    revealedHoleCards: Object.freeze(state.revealedHoleCards.map(freezeRevealedHand)),
  });
}
