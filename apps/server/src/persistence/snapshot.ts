import { z } from "zod";

import {
  ActionSemantic,
  AdministrativeFoldReason,
  HandCompletionReason,
  LedgerEntryType,
  PlayerActionType,
  PotKind,
  Street,
  TableLifecycleStatus,
} from "@friend-poker/poker-engine";
import type { TableState } from "@friend-poker/poker-engine";
import type { DurableIdentityRecord } from "../transport/identity.js";

export const DURABLE_SNAPSHOT_SCHEMA_VERSION = 1;

const playerIdSchema = z.string().min(1);
const tableSeatSchema = z.number().int().min(0).max(5);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const metadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const metadataSchema = z.record(z.string(), metadataValueSchema);
const cardSchema = z.object({
  rank: z.number().int().min(2).max(14),
  suit: z.enum(["c", "d", "h", "s"]),
}).strict();
const holeCardsSchema = z.tuple([cardSchema, cardSchema]);

const bettingActionSchema = z.object({
  playerId: playerIdSchema,
  requestedType: z.enum(Object.values(PlayerActionType)),
  semantic: z.enum(Object.values(ActionSemantic)),
  amountCommitted: nonNegativeIntegerSchema,
  toContribution: nonNegativeIntegerSchema,
  isAllIn: z.boolean(),
  isFullBetOrRaise: z.boolean(),
}).strict();
const handActionEventSchema = bettingActionSchema.extend({
  type: z.literal("ACTION"),
  sequence: nonNegativeIntegerSchema,
  street: z.enum(Object.values(Street)),
});
const administrativeFoldEventSchema = z.object({
  type: z.literal("ADMINISTRATIVE_FOLD"),
  sequence: nonNegativeIntegerSchema,
  handId: z.string().min(1),
  targetPlayerId: playerIdSchema,
  reason: z.enum(Object.values(AdministrativeFoldReason)),
  operatorPlayerId: playerIdSchema.nullable(),
}).strict();
const boardRevealEventSchema = z.object({
  type: z.literal("BOARD_REVEALED"),
  sequence: nonNegativeIntegerSchema,
  street: z.enum([Street.Flop, Street.Turn, Street.River]),
  cards: z.array(cardSchema),
}).strict();
const revealedHoleCardsSchema = z.object({
  playerId: playerIdSchema,
  cards: holeCardsSchema,
  reason: z.enum(["SHOWDOWN", "VOLUNTARY_UNCONTESTED"]),
}).strict();
const holeCardsRevealEventSchema = z.object({
  type: z.literal("HOLE_CARDS_REVEALED"),
  sequence: nonNegativeIntegerSchema,
  reason: z.enum(["SHOWDOWN", "VOLUNTARY_UNCONTESTED"]),
  hands: z.array(revealedHoleCardsSchema),
}).strict();
const handSettledEventSchema = z.object({
  type: z.literal("HAND_SETTLED"),
  sequence: nonNegativeIntegerSchema,
  reason: z.enum(Object.values(HandCompletionReason)),
}).strict();
const handEventSchema = z.discriminatedUnion("type", [
  handActionEventSchema,
  administrativeFoldEventSchema,
  boardRevealEventSchema,
  holeCardsRevealEventSchema,
  handSettledEventSchema,
]);

const playerAmountSchema = z.object({
  playerId: playerIdSchema,
  amount: nonNegativeIntegerSchema,
}).strict();
const constructedPotSchema = z.object({
  potIndex: nonNegativeIntegerSchema,
  kind: z.enum(Object.values(PotKind)),
  contributionFrom: nonNegativeIntegerSchema,
  contributionTo: nonNegativeIntegerSchema,
  amount: nonNegativeIntegerSchema,
  contributorPlayerIds: z.array(playerIdSchema),
  eligiblePlayerIds: z.array(playerIdSchema),
}).strict();
const settledPotSchema = constructedPotSchema.extend({
  winnerPlayerIds: z.array(playerIdSchema),
  payouts: z.array(playerAmountSchema.extend({ oddChips: nonNegativeIntegerSchema })),
});
const handRankSchema = z.object({
  category: z.number().int().min(0).max(8),
  tiebreakers: z.array(z.number().int()),
  bestFive: z.array(cardSchema).length(5),
}).strict();
const settlementSchema = z.object({
  refunds: z.array(playerAmountSchema),
  pots: z.array(settledPotSchema),
  evaluatedHands: z.array(z.object({
    playerId: playerIdSchema,
    handRank: handRankSchema,
  }).strict()),
  totalPayouts: z.array(playerAmountSchema),
  finalStacks: z.array(z.object({
    playerId: playerIdSchema,
    seat: tableSeatSchema,
    stack: nonNegativeIntegerSchema,
  }).strict()),
  totalContribution: nonNegativeIntegerSchema,
  totalRefund: nonNegativeIntegerSchema,
  totalPotAmount: nonNegativeIntegerSchema,
  totalPotPayout: nonNegativeIntegerSchema,
  totalStartingStacks: nonNegativeIntegerSchema,
  totalFinalStacks: nonNegativeIntegerSchema,
}).strict();
const safeHandRecordSchema = z.object({
  handId: z.string().min(1),
  participants: z.array(z.object({
    playerId: playerIdSchema,
    seat: tableSeatSchema,
    startingStack: nonNegativeIntegerSchema,
  }).strict()),
  buttonSeat: tableSeatSchema,
  smallBlindSeat: tableSeatSchema,
  bigBlindSeat: tableSeatSchema,
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  actions: z.array(handActionEventSchema),
  board: z.array(cardSchema).max(5),
  flop: z.array(cardSchema).max(3),
  turn: cardSchema.nullable(),
  river: cardSchema.nullable(),
  events: z.array(handEventSchema),
  completionReason: z.enum(Object.values(HandCompletionReason)).nullable(),
  settlement: settlementSchema.nullable(),
  revealedHoleCards: z.array(revealedHoleCardsSchema),
}).strict();

const tablePlayerSchema = z.object({
  playerId: playerIdSchema,
  nickname: z.string().nullable(),
  seat: tableSeatSchema.nullable(),
  present: z.boolean(),
  online: z.literal(false),
  pendingLeaveAfterHand: z.boolean(),
  sessionParticipant: z.boolean(),
  initialGrantReceived: z.boolean(),
  chipBalance: nonNegativeIntegerSchema,
}).strict();
const ledgerEntrySchema = z.object({
  ledgerEntryId: z.string().min(1),
  sessionId: z.string().min(1),
  playerId: playerIdSchema,
  amount: z.number().int().refine((amount) => amount !== 0),
  type: z.enum(Object.values(LedgerEntryType)),
  operatorPlayerId: playerIdSchema.nullable(),
  sequence: nonNegativeIntegerSchema,
  metadata: metadataSchema.nullable(),
}).strict();
const activeSessionSchema = z.object({
  sessionId: z.string().min(1),
  blinds: z.object({
    smallBlind: z.number().int().positive(),
    bigBlind: z.number().int().positive(),
  }).strict(),
  ledger: z.array(ledgerEntrySchema),
  participantPlayerIds: z.array(playerIdSchema),
  completedHandCount: nonNegativeIntegerSchema,
  lastButtonSeat: tableSeatSchema.nullable(),
  startMetadata: metadataSchema.nullable(),
}).strict();
const sessionPlayerSummarySchema = z.object({
  playerId: playerIdSchema,
  nickname: z.string().nullable().optional(),
  initialGrants: z.number().int(),
  replenishments: z.number().int(),
  hostAdjustments: z.number().int(),
  finalChipBalance: nonNegativeIntegerSchema,
  netResult: z.number().int(),
}).strict();
const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  participantPlayerIds: z.array(playerIdSchema),
  players: z.array(sessionPlayerSummarySchema),
  handCount: nonNegativeIntegerSchema,
  startMetadata: metadataSchema.nullable(),
  endMetadata: metadataSchema.nullable(),
}).strict();

const durableSnapshotSchema = z.object({
  schemaVersion: z.literal(DURABLE_SNAPSHOT_SCHEMA_VERSION),
  table: z.object({
    status: z.enum([
      TableLifecycleStatus.NoSession,
      TableLifecycleStatus.WaitingForFirstHand,
      TableLifecycleStatus.BetweenHands,
      TableLifecycleStatus.SessionEnded,
    ]),
    players: z.array(tablePlayerSchema),
    hostPlayerId: playerIdSchema.nullable(),
    session: activeSessionSchema.nullable(),
    recentHands: z.array(z.object({
      sessionId: z.string().min(1),
      handNumber: z.number().int().positive(),
      record: safeHandRecordSchema,
    }).strict()).max(20),
    recentSessions: z.array(sessionSummarySchema).max(20),
  }).strict(),
}).strict();

export class DurableSnapshotError extends Error {}

export function serializeDurableCheckpoint(state: TableState): string {
  if (state.status === TableLifecycleStatus.HandInProgress || state.activeHand !== null) {
    throw new DurableSnapshotError("An in-progress hand cannot become a durable checkpoint");
  }
  return JSON.stringify(durableSnapshotSchema.parse({
    schemaVersion: DURABLE_SNAPSHOT_SCHEMA_VERSION,
    table: {
      status: state.status,
      players: state.players.map((player) => ({ ...player, online: false as const })),
      hostPlayerId: state.hostPlayerId,
      session: state.session,
      recentHands: state.recentHands,
      recentSessions: state.recentSessions,
    },
  }));
}

export function restoreDurableCheckpoint(serialized: string): TableState {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new DurableSnapshotError("Durable checkpoint is not valid JSON");
  }
  const parsed = durableSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableSnapshotError(`Durable checkpoint validation failed: ${parsed.error.message}`);
  }
  return Object.freeze({
    status: parsed.data.table.status,
    players: parsed.data.table.players.map((player) => Object.freeze({ ...player, online: false })),
    hostPlayerId: parsed.data.table.hostPlayerId,
    session: parsed.data.table.session,
    activeHand: null,
    uncontestedRevealOpportunity: null,
    recentHands: parsed.data.table.recentHands,
    recentSessions: parsed.data.table.recentSessions,
  }) as TableState;
}

export function prepareCheckpointForProcessStart(
  state: TableState,
  identities: readonly DurableIdentityRecord[],
): TableState {
  const kicked = new Set(
    identities.filter((identity) => identity.state === "KICKED").map((identity) => identity.playerId),
  );
  return Object.freeze({
    ...state,
    players: state.players.map((player) => Object.freeze({
      ...player,
      online: false,
      ...(kicked.has(player.playerId)
        ? { seat: null, present: false, pendingLeaveAfterHand: false }
        : {}),
    })),
    hostPlayerId:
      state.hostPlayerId !== null && kicked.has(state.hostPlayerId) ? null : state.hostPlayerId,
    activeHand: null,
    uncontestedRevealOpportunity: null,
  });
}
