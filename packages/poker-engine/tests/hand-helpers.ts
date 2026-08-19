import {
  applyHandAction,
  createDeck,
  HandLifecycleStatus,
  legalActions,
  parseCard,
  PlayerActionType,
  startHand,
} from "../src/index.js";
import type {
  Card,
  HandCommand,
  OrchestratedHandState,
  PlayerId,
  RandomSource,
  Seat,
} from "../src/index.js";
import { cardKey, seededRandom } from "./helpers.js";

const PLAYER_IDS = ["A", "B", "C", "D", "E", "F"] as const;

export function startOrchestratedHand(
  stacks: readonly number[],
  options: {
    readonly buttonSeat?: Seat;
    readonly seats?: readonly Seat[];
    readonly handId?: string;
    readonly rng?: RandomSource;
  } = {},
): OrchestratedHandState {
  const seats = options.seats ?? stacks.map((_, index) => index);
  return startHand(
    {
      handId: options.handId ?? "hand-test",
      participants: stacks.map((stack, index) => ({
        playerId: PLAYER_IDS[index]!,
        seat: seats[index]!,
        stack,
      })),
      buttonSeat: options.buttonSeat ?? seats[0]!,
      smallBlind: 1,
      bigBlind: 2,
    },
    options.rng ?? seededRandom(0x4a11_2026),
  );
}

export function actHand(
  state: OrchestratedHandState,
  type: HandCommand["type"],
  amount?: number,
): OrchestratedHandState {
  const playerId = state.bettingState.currentActorId;
  if (playerId === null) throw new Error("Test attempted to act without an actor");
  if (type === PlayerActionType.Bet) {
    return applyHandAction(state, { playerId, type, amount: amount! });
  }
  if (type === PlayerActionType.Raise) {
    return applyHandAction(state, { playerId, type, raiseTo: amount! });
  }
  return applyHandAction(state, { playerId, type });
}

export function callOrCheck(state: OrchestratedHandState): OrchestratedHandState {
  const legal = legalActions(state.bettingState);
  return actHand(state, legal.canCheck ? PlayerActionType.Check : PlayerActionType.Call);
}

export function finishByCallingAndChecking(
  state: OrchestratedHandState,
): OrchestratedHandState {
  let next = state;
  while (next.status === HandLifecycleStatus.Betting) next = callOrCheck(next);
  return next;
}

export function privateCards(
  state: OrchestratedHandState,
  playerId: PlayerId,
): readonly [Card, Card] {
  const hand = state.privateHoleCards.find((candidate) => candidate.playerId === playerId);
  if (hand === undefined) throw new Error(`Missing private cards for ${playerId}`);
  return hand.cards;
}

export function allAccountedCards(state: OrchestratedHandState): readonly Card[] {
  return [
    ...state.remainingDeck,
    ...state.privateHoleCards.flatMap((hand) => hand.cards),
    ...state.board,
  ];
}

export function assertCardAccounting(state: OrchestratedHandState): void {
  const all = allAccountedCards(state);
  if (all.length !== 52 || new Set(all.map(cardKey)).size !== 52) {
    throw new Error("Hand does not account for 52 unique cards");
  }
  if (![0, 3, 4, 5].includes(state.board.length)) {
    throw new Error(`Invalid board length ${state.board.length}`);
  }
}

export function riggedRng(prefixNotations: readonly string[]): RandomSource {
  const original = [...createDeck()];
  const prefix = prefixNotations.map(parseCard);
  const prefixKeys = new Set(prefix.map(cardKey));
  if (prefixKeys.size !== prefix.length) throw new Error("Rigged deck prefix has duplicates");
  const target = [...prefix, ...original.filter((card) => !prefixKeys.has(cardKey(card)))];
  const working = [...original];
  const choices: number[] = [];
  for (let index = working.length - 1; index > 0; index -= 1) {
    const targetKey = cardKey(target[index]!);
    const swapIndex = working.findIndex(
      (card, candidateIndex) => candidateIndex <= index && cardKey(card) === targetKey,
    );
    if (swapIndex < 0) throw new Error("Could not construct rigged shuffle");
    choices.push((swapIndex + 0.5) / (index + 1));
    [working[index], working[swapIndex]] = [working[swapIndex]!, working[index]!];
  }
  let cursor = 0;
  return () => choices[cursor++] ?? 0;
}
