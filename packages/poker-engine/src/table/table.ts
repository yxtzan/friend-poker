import { moveButton } from "../betting/index.js";
import type { PlayerId } from "../betting/index.js";
import {
  AdministrativeFoldReason,
  advanceRunout,
  administrativelyFoldHandParticipant,
  applyHandAction,
  getHandRecord,
  HandCompletionReason,
  HandLifecycleStatus,
  revealUncontestedWinner,
  startHand,
} from "../hand/index.js";
import type { HandCommand, OrchestratedHandState } from "../hand/index.js";
import type { RandomSource } from "../types.js";
import { TableDomainError } from "./errors.js";
import {
  INITIAL_CHIP_GRANT,
  LedgerEntryType,
  RECENT_HISTORY_LIMIT,
  REPLENISHMENT_AMOUNT,
  SPECTATOR_SLOT_COUNT,
  TABLE_SEAT_COUNT,
  TableLifecycleStatus,
} from "./types.js";
import type {
  ActiveSession,
  AdministrativeFoldTableInput,
  AdjustPlayerChipsInput,
  AutoEndSessionInput,
  ChangeBlindsInput,
  ChipLedgerEntry,
  DomainMetadata,
  EndSessionInput,
  EnterTableInput,
  InitialGrantDetails,
  KickPlayerInput,
  LedgerEntryDetails,
  NetResultInput,
  ReplenishPlayerInput,
  SessionEndPreview,
  SessionPlayerSummary,
  SessionSummary,
  SetLifecycleHostInput,
  SitPlayerInput,
  StartFirstHandInput,
  StartNextHandInput,
  StartSessionInput,
  TableHandRecord,
  TablePlayer,
  TableSeat,
  TableState,
  TransferHostInput,
  UncontestedRevealOpportunity,
} from "./types.js";

function freezeMetadata(metadata: DomainMetadata | undefined): DomainMetadata | null {
  return metadata === undefined ? null : Object.freeze({ ...metadata });
}

function freezePlayer(player: TablePlayer): TablePlayer {
  return Object.freeze({ ...player });
}

function freezeLedgerEntry(entry: ChipLedgerEntry): ChipLedgerEntry {
  return Object.freeze({ ...entry, metadata: freezeMetadata(entry.metadata ?? undefined) });
}

function freezeSession(session: ActiveSession | null): ActiveSession | null {
  if (session === null) return null;
  return Object.freeze({
    ...session,
    blinds: Object.freeze({ ...session.blinds }),
    ledger: Object.freeze(session.ledger.map(freezeLedgerEntry)),
    participantPlayerIds: Object.freeze([...session.participantPlayerIds]),
    startMetadata: freezeMetadata(session.startMetadata ?? undefined),
  });
}

function freezeHandRecord(record: TableHandRecord): TableHandRecord {
  return Object.freeze({ ...record });
}

function freezePlayerSummary(summary: SessionPlayerSummary): SessionPlayerSummary {
  return Object.freeze({ ...summary });
}

function freezeSessionSummary(summary: SessionSummary): SessionSummary {
  return Object.freeze({
    ...summary,
    participantPlayerIds: Object.freeze([...summary.participantPlayerIds]),
    players: Object.freeze(summary.players.map(freezePlayerSummary)),
    startMetadata: freezeMetadata(summary.startMetadata ?? undefined),
    endMetadata: freezeMetadata(summary.endMetadata ?? undefined),
  });
}

function freezeRevealOpportunity(
  opportunity: UncontestedRevealOpportunity | null,
): UncontestedRevealOpportunity | null {
  return opportunity === null ? null : Object.freeze({ ...opportunity });
}

function freezeState(state: TableState): TableState {
  return Object.freeze({
    ...state,
    players: Object.freeze(state.players.map(freezePlayer)),
    session: freezeSession(state.session),
    uncontestedRevealOpportunity: freezeRevealOpportunity(
      state.uncontestedRevealOpportunity,
    ),
    recentHands: Object.freeze(state.recentHands.map(freezeHandRecord)),
    recentSessions: Object.freeze(state.recentSessions.map(freezeSessionSummary)),
  });
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new TableDomainError(`${label} must not be empty`);
}

function requirePlayer(state: TableState, playerId: PlayerId): TablePlayer {
  const player = state.players.find((candidate) => candidate.playerId === playerId);
  if (player === undefined) throw new TableDomainError(`Unknown player ${playerId}`);
  return player;
}

function requirePresentPlayer(state: TableState, playerId: PlayerId): TablePlayer {
  const player = requirePlayer(state, playerId);
  if (!player.present) throw new TableDomainError(`Player ${playerId} is not present`);
  return player;
}

function requireSession(state: TableState): ActiveSession {
  if (state.session === null || state.status === TableLifecycleStatus.NoSession) {
    throw new TableDomainError("No Session exists");
  }
  return state.session;
}

function requireActiveSession(state: TableState): ActiveSession {
  const session = requireSession(state);
  if (state.status === TableLifecycleStatus.SessionEnded) {
    throw new TableDomainError("The Session has ended");
  }
  return session;
}

function requireHost(state: TableState, operatorPlayerId: PlayerId): void {
  if (state.hostPlayerId !== operatorPlayerId) {
    throw new TableDomainError("Operation requires the current host");
  }
  requirePresentPlayer(state, operatorPlayerId);
}

function requireNonHandSession(state: TableState): ActiveSession {
  const session = requireActiveSession(state);
  if (state.status === TableLifecycleStatus.HandInProgress) {
    throw new TableDomainError("Operation is not allowed while a hand is in progress");
  }
  return session;
}

function updatePlayer(
  state: TableState,
  playerId: PlayerId,
  update: (player: TablePlayer) => TablePlayer,
): TableState {
  let found = false;
  const players = state.players.map((player) => {
    if (player.playerId !== playerId) return player;
    found = true;
    return update(player);
  });
  if (!found) throw new TableDomainError(`Unknown player ${playerId}`);
  return freezeState({ ...state, players });
}

function validateSeat(seat: TableSeat): void {
  if (!Number.isInteger(seat) || seat < 0 || seat >= TABLE_SEAT_COUNT) {
    throw new TableDomainError(
      `Seat must be an integer from 0 through ${TABLE_SEAT_COUNT - 1}`,
    );
  }
}

function requireEmptySeat(state: TableState, seat: TableSeat, playerId?: PlayerId): void {
  validateSeat(seat);
  const occupant = state.players.find(
    (candidate) => candidate.seat === seat && candidate.playerId !== playerId,
  );
  if (occupant !== undefined) throw new TableDomainError(`Seat ${seat} is occupied`);
}

function spectatorCount(state: TableState, excludingPlayerId?: PlayerId): number {
  return state.players.filter(
    (player) =>
      player.playerId !== excludingPlayerId && player.present && player.seat === null,
  ).length;
}

function requireSpectatorCapacity(state: TableState, excludingPlayerId?: PlayerId): void {
  if (spectatorCount(state, excludingPlayerId) >= SPECTATOR_SLOT_COUNT) {
    throw new TableDomainError("Both spectator slots are occupied");
  }
}

function appendLedgerEntry(
  state: TableState,
  playerId: PlayerId,
  amount: number,
  type: ChipLedgerEntry["type"],
  operatorPlayerId: PlayerId | null,
  details: LedgerEntryDetails,
): TableState {
  const session = requireActiveSession(state);
  requireNonEmpty(details.ledgerEntryId, "Ledger entry ID");
  if (!Number.isInteger(amount) || amount === 0) {
    throw new TableDomainError("Ledger amount must be a non-zero integer");
  }
  if (session.ledger.some((entry) => entry.ledgerEntryId === details.ledgerEntryId)) {
    throw new TableDomainError(`Duplicate ledger entry ID ${details.ledgerEntryId}`);
  }
  const player = requirePlayer(state, playerId);
  const nextBalance = player.chipBalance + amount;
  if (nextBalance < 0) throw new TableDomainError("Chip balance cannot be negative");
  const entry: ChipLedgerEntry = freezeLedgerEntry({
    ledgerEntryId: details.ledgerEntryId,
    sessionId: session.sessionId,
    playerId,
    amount,
    type,
    operatorPlayerId,
    sequence: session.ledger.length,
    metadata: freezeMetadata(details.metadata),
  });
  const players = state.players.map((candidate) =>
    candidate.playerId === playerId
      ? freezePlayer({
          ...candidate,
          chipBalance: nextBalance,
          sessionParticipant: true,
          initialGrantReceived:
            candidate.initialGrantReceived || type === LedgerEntryType.InitialGrant,
        })
      : candidate,
  );
  const participantPlayerIds = session.participantPlayerIds.includes(playerId)
    ? session.participantPlayerIds
    : Object.freeze([...session.participantPlayerIds, playerId]);
  return freezeState({
    ...state,
    players,
    session: {
      ...session,
      ledger: Object.freeze([...session.ledger, entry]),
      participantPlayerIds,
    },
  });
}

function grantInitialChipsIfRequired(
  state: TableState,
  playerId: PlayerId,
  details: LedgerEntryDetails | undefined,
): TableState {
  if (
    state.session === null ||
    state.status === TableLifecycleStatus.NoSession ||
    state.status === TableLifecycleStatus.SessionEnded
  ) {
    if (details !== undefined) {
      throw new TableDomainError("Initial grant details were supplied without an active Session");
    }
    return state;
  }
  const player = requirePlayer(state, playerId);
  if (player.initialGrantReceived) {
    if (details !== undefined) {
      throw new TableDomainError("Player has already received initial Session chips");
    }
    return state;
  }
  if (details === undefined) {
    throw new TableDomainError("First Session sit requires a caller-supplied ledger entry ID");
  }
  return appendLedgerEntry(
    state,
    playerId,
    INITIAL_CHIP_GRANT,
    LedgerEntryType.InitialGrant,
    null,
    details,
  );
}

function trimToRecent<T>(records: readonly T[]): readonly T[] {
  return Object.freeze(records.slice(-RECENT_HISTORY_LIMIT));
}

function totalByType(
  ledger: readonly ChipLedgerEntry[],
  playerId: PlayerId,
  type: ChipLedgerEntry["type"],
): number {
  return ledger
    .filter((entry) => entry.playerId === playerId && entry.type === type)
    .reduce((total, entry) => total + entry.amount, 0);
}

function sessionPlayerSummary(
  state: TableState,
  session: ActiveSession,
  playerId: PlayerId,
): SessionPlayerSummary {
  const player = requirePlayer(state, playerId);
  const initialGrants = totalByType(session.ledger, playerId, LedgerEntryType.InitialGrant);
  const replenishments = totalByType(
    session.ledger,
    playerId,
    LedgerEntryType.Replenishment,
  );
  const hostAdjustments = totalByType(
    session.ledger,
    playerId,
    LedgerEntryType.HostAdjustment,
  );
  return freezePlayerSummary({
    playerId,
    initialGrants,
    replenishments,
    hostAdjustments,
    finalChipBalance: player.chipBalance,
    netResult: calculateNetResult({
      finalChips: player.chipBalance,
      initialGrants,
      replenishments,
      hostAdjustments,
    }),
  });
}

function reconcileCompletedHand(
  state: TableState,
  completedHand: OrchestratedHandState,
): TableState {
  const session = requireActiveSession(state);
  if (
    completedHand.status !== HandLifecycleStatus.Complete ||
    completedHand.settlement === null
  ) {
    return freezeState({ ...state, activeHand: completedHand });
  }

  const finalStacks = new Map(
    completedHand.settlement.finalStacks.map((stack) => [stack.playerId, stack.stack]),
  );
  const players = state.players.map((player) => {
    const finalStack = finalStacks.get(player.playerId);
    const reconciled = finalStack === undefined ? player : { ...player, chipBalance: finalStack };
    return freezePlayer(
      reconciled.pendingLeaveAfterHand
        ? {
            ...reconciled,
            seat: null,
            present: false,
            online: false,
            pendingLeaveAfterHand: false,
          }
        : reconciled,
    );
  });
  const handNumber = session.completedHandCount + 1;
  const tableRecord: TableHandRecord = freezeHandRecord({
    sessionId: session.sessionId,
    handNumber,
    record: getHandRecord(completedHand),
  });
  const revealOpportunity: UncontestedRevealOpportunity | null =
    completedHand.completionReason === HandCompletionReason.Uncontested
      ? freezeRevealOpportunity({
          sessionId: session.sessionId,
          handNumber,
          hand: completedHand,
        })
      : null;
  return freezeState({
    ...state,
    status: TableLifecycleStatus.BetweenHands,
    players,
    session: { ...session, completedHandCount: handNumber },
    activeHand: null,
    uncontestedRevealOpportunity: revealOpportunity,
    recentHands: trimToRecent([...state.recentHands, tableRecord]),
  });
}

function startTableHand(
  state: TableState,
  handId: string,
  buttonSeat: TableSeat,
  rng: RandomSource,
): TableState {
  const session = requireActiveSession(state);
  const eligible = getEligiblePlayers(state);
  if (eligible.length < 2) throw new TableDomainError("At least two eligible players are required");
  if (!eligible.some((player) => player.seat === buttonSeat)) {
    throw new TableDomainError("Button seat must belong to an eligible player");
  }
  const hand = startHand(
    {
      handId,
      participants: eligible.map((player) => ({
        playerId: player.playerId,
        seat: player.seat!,
        stack: player.chipBalance,
      })),
      buttonSeat,
      smallBlind: session.blinds.smallBlind,
      bigBlind: session.blinds.bigBlind,
    },
    rng,
  );
  const next = freezeState({
    ...state,
    status: TableLifecycleStatus.HandInProgress,
    session: { ...session, lastButtonSeat: buttonSeat },
    activeHand: hand,
    uncontestedRevealOpportunity: null,
  });
  return hand.status === HandLifecycleStatus.Complete
    ? reconcileCompletedHand(next, hand)
    : next;
}

export function createTableState(): TableState {
  return freezeState({
    status: TableLifecycleStatus.NoSession,
    players: Object.freeze([]),
    hostPlayerId: null,
    session: null,
    activeHand: null,
    uncontestedRevealOpportunity: null,
    recentHands: Object.freeze([]),
    recentSessions: Object.freeze([]),
  });
}

export function enterTable(state: TableState, input: EnterTableInput): TableState {
  requireNonEmpty(input.playerId, "Player ID");
  const existing = state.players.find((player) => player.playerId === input.playerId);
  if (existing?.present === true || existing?.pendingLeaveAfterHand === true) {
    throw new TableDomainError(`Player ${input.playerId} is already present or pending leave`);
  }
  if (input.position.kind === "SPECTATOR") requireSpectatorCapacity(state, input.playerId);
  else requireEmptySeat(state, input.position.seat, input.playerId);

  const seat = input.position.kind === "SEAT" ? input.position.seat : null;
  const player: TablePlayer = freezePlayer(
    existing === undefined
      ? {
          playerId: input.playerId,
          nickname: input.nickname ?? null,
          seat,
          present: true,
          online: input.online ?? true,
          pendingLeaveAfterHand: false,
          sessionParticipant: false,
          initialGrantReceived: false,
          chipBalance: 0,
        }
      : {
          ...existing,
          nickname: input.nickname ?? existing.nickname,
          seat,
          present: true,
          online: input.online ?? true,
          pendingLeaveAfterHand: false,
        },
  );
  let next = freezeState({
    ...state,
    players:
      existing === undefined
        ? [...state.players, player]
        : state.players.map((candidate) =>
            candidate.playerId === input.playerId ? player : candidate,
          ),
    hostPlayerId: state.hostPlayerId ?? input.playerId,
  });
  if (seat !== null) {
    next = grantInitialChipsIfRequired(next, input.playerId, input.initialGrant);
  } else if (input.initialGrant !== undefined) {
    throw new TableDomainError("Spectating does not grant initial Session chips");
  }
  return next;
}

export function seatPlayer(state: TableState, input: SitPlayerInput): TableState {
  const player = requirePresentPlayer(state, input.playerId);
  requireEmptySeat(state, input.seat, input.playerId);
  if (player.seat === input.seat) {
    if (input.initialGrant !== undefined) {
      throw new TableDomainError("Player already occupies this seat");
    }
    return state;
  }
  if (player.seat !== null && state.status === TableLifecycleStatus.HandInProgress) {
    throw new TableDomainError("Seat changes are not allowed during a hand");
  }
  let next = updatePlayer(state, input.playerId, (candidate) => ({
    ...candidate,
    seat: input.seat,
  }));
  next = grantInitialChipsIfRequired(next, input.playerId, input.initialGrant);
  return next;
}

export function standToSpectate(state: TableState, playerId: PlayerId): TableState {
  const player = requirePresentPlayer(state, playerId);
  if (state.status === TableLifecycleStatus.HandInProgress) {
    throw new TableDomainError("Standing to spectate is not allowed during a hand");
  }
  if (player.seat === null) return state;
  requireSpectatorCapacity(state, playerId);
  return updatePlayer(state, playerId, (candidate) => ({ ...candidate, seat: null }));
}

export function leaveTable(state: TableState, playerId: PlayerId): TableState {
  requirePresentPlayer(state, playerId);
  const isCurrentParticipant =
    state.activeHand?.bettingState.participants.some(
      (participant) => participant.playerId === playerId,
    ) ?? false;
  const hostPlayerId = state.hostPlayerId === playerId ? null : state.hostPlayerId;
  let next = updatePlayer(
    freezeState({ ...state, hostPlayerId }),
    playerId,
    (candidate) =>
      state.status === TableLifecycleStatus.HandInProgress && isCurrentParticipant
        ? {
            ...candidate,
            present: false,
            online: false,
            pendingLeaveAfterHand: true,
          }
        : {
            ...candidate,
            seat: null,
            present: false,
            online: false,
            pendingLeaveAfterHand: false,
          },
  );
  const handParticipant = next.activeHand?.bettingState.participants.find(
    (candidate) => candidate.playerId === playerId,
  );
  if (handParticipant !== undefined && !handParticipant.folded) {
    next = administrativelyFoldTableParticipant(next, {
      targetPlayerId: playerId,
      reason: AdministrativeFoldReason.ExplicitLeave,
      operatorPlayerId: playerId,
    });
  }
  return next;
}

export function kickPlayer(state: TableState, input: KickPlayerInput): TableState {
  requireHost(state, input.operatorPlayerId);
  if (input.targetPlayerId === input.operatorPlayerId) {
    throw new TableDomainError("Host cannot kick themselves");
  }
  requirePresentPlayer(state, input.targetPlayerId);
  const participating =
    state.status === TableLifecycleStatus.HandInProgress &&
    state.activeHand?.bettingState.participants.some(
      (participant) => participant.playerId === input.targetPlayerId,
    ) === true;
  let next = updatePlayer(state, input.targetPlayerId, (player) =>
    participating
      ? {
          ...player,
          present: false,
          online: false,
          pendingLeaveAfterHand: true,
        }
      : {
          ...player,
          seat: null,
          present: false,
          online: false,
          pendingLeaveAfterHand: false,
        },
  );
  const handParticipant = next.activeHand?.bettingState.participants.find(
    (participant) => participant.playerId === input.targetPlayerId,
  );
  if (handParticipant !== undefined && !handParticipant.folded) {
    next = administrativelyFoldTableParticipant(next, {
      targetPlayerId: input.targetPlayerId,
      reason: AdministrativeFoldReason.Kick,
      operatorPlayerId: input.operatorPlayerId,
    });
  }
  return next;
}

export function setPlayerOnline(
  state: TableState,
  playerId: PlayerId,
  online: boolean,
): TableState {
  requirePresentPlayer(state, playerId);
  return updatePlayer(state, playerId, (player) => ({ ...player, online }));
}

export function transferHost(state: TableState, input: TransferHostInput): TableState {
  requireHost(state, input.operatorPlayerId);
  requirePresentPlayer(state, input.targetPlayerId);
  return freezeState({ ...state, hostPlayerId: input.targetPlayerId });
}

/** Trusted lifecycle-only host assignment used after grace/election rules. */
export function setLifecycleHost(
  state: TableState,
  input: SetLifecycleHostInput,
): TableState {
  if (input.targetPlayerId === null) {
    return state.hostPlayerId === null ? state : freezeState({ ...state, hostPlayerId: null });
  }
  const target = requirePresentPlayer(state, input.targetPlayerId);
  if (!target.online) throw new TableDomainError("Lifecycle host must be online");
  return state.hostPlayerId === target.playerId
    ? state
    : freezeState({ ...state, hostPlayerId: target.playerId });
}

export function startSession(state: TableState, input: StartSessionInput): TableState {
  requireHost(state, input.operatorPlayerId);
  if (
    state.status !== TableLifecycleStatus.NoSession &&
    state.status !== TableLifecycleStatus.SessionEnded
  ) {
    throw new TableDomainError("A Session is already active");
  }
  requireNonEmpty(input.sessionId, "Session ID");
  const seated = state.players
    .filter((player) => player.present && player.seat !== null)
    .sort((left, right) => left.seat! - right.seat!);
  const grantsByPlayer = new Map<PlayerId, InitialGrantDetails>();
  for (const grant of input.initialGrants) {
    if (grantsByPlayer.has(grant.playerId)) {
      throw new TableDomainError(`Duplicate initial grant for ${grant.playerId}`);
    }
    grantsByPlayer.set(grant.playerId, grant);
  }
  if (
    grantsByPlayer.size !== seated.length ||
    seated.some((player) => !grantsByPlayer.has(player.playerId))
  ) {
    throw new TableDomainError("Initial grant details must match all seated players exactly");
  }
  let next = freezeState({
    ...state,
    status: TableLifecycleStatus.WaitingForFirstHand,
    players: state.players.map((player) => ({
      ...player,
      chipBalance: 0,
      sessionParticipant: false,
      initialGrantReceived: false,
      pendingLeaveAfterHand: false,
    })),
    session: {
      sessionId: input.sessionId,
      blinds: { smallBlind: 1, bigBlind: 2 },
      ledger: Object.freeze([]),
      participantPlayerIds: Object.freeze([]),
      completedHandCount: 0,
      lastButtonSeat: null,
      startMetadata: freezeMetadata(input.startMetadata),
    },
    activeHand: null,
    uncontestedRevealOpportunity: null,
  });
  for (const player of seated) {
    next = appendLedgerEntry(
      next,
      player.playerId,
      INITIAL_CHIP_GRANT,
      LedgerEntryType.InitialGrant,
      null,
      grantsByPlayer.get(player.playerId)!,
    );
  }
  return next;
}

export function replenishPlayer(
  state: TableState,
  input: ReplenishPlayerInput,
): TableState {
  requireNonHandSession(state);
  const player = requirePresentPlayer(state, input.playerId);
  if (!player.initialGrantReceived) {
    throw new TableDomainError("Player must receive initial Session chips before replenishing");
  }
  return appendLedgerEntry(
    state,
    input.playerId,
    REPLENISHMENT_AMOUNT,
    LedgerEntryType.Replenishment,
    input.playerId,
    input,
  );
}

export function adjustPlayerChips(
  state: TableState,
  input: AdjustPlayerChipsInput,
): TableState {
  requireHost(state, input.operatorPlayerId);
  requireNonHandSession(state);
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new TableDomainError("Host adjustment must be a non-zero signed integer");
  }
  const player = requirePlayer(state, input.playerId);
  if (!player.sessionParticipant) {
    throw new TableDomainError("Target player is not a participant in this Session");
  }
  return appendLedgerEntry(
    state,
    input.playerId,
    input.amount,
    LedgerEntryType.HostAdjustment,
    input.operatorPlayerId,
    input,
  );
}

export function getPlayerNetResult(state: TableState, playerId: PlayerId): number {
  const session = requireSession(state);
  if (!session.participantPlayerIds.includes(playerId)) {
    throw new TableDomainError("Player is not a participant in this Session");
  }
  return sessionPlayerSummary(state, session, playerId).netResult;
}

export function calculateNetResult(input: NetResultInput): number {
  const values = [
    input.finalChips,
    input.initialGrants,
    input.replenishments,
    input.hostAdjustments,
  ];
  if (values.some((value) => !Number.isInteger(value))) {
    throw new TableDomainError("Net result inputs must be integers");
  }
  return (
    input.finalChips -
    input.initialGrants -
    input.replenishments -
    input.hostAdjustments
  );
}

export function changeBlinds(state: TableState, input: ChangeBlindsInput): TableState {
  requireHost(state, input.operatorPlayerId);
  const session = requireNonHandSession(state);
  if (
    !Number.isInteger(input.smallBlind) ||
    !Number.isInteger(input.bigBlind) ||
    input.smallBlind <= 0 ||
    input.bigBlind <= 0 ||
    input.smallBlind >= input.bigBlind
  ) {
    throw new TableDomainError("Blinds must be positive integers with small blind below big blind");
  }
  return freezeState({
    ...state,
    session: {
      ...session,
      blinds: { smallBlind: input.smallBlind, bigBlind: input.bigBlind },
    },
  });
}

export function getEligiblePlayers(state: TableState): readonly TablePlayer[] {
  requireActiveSession(state);
  return Object.freeze(
    state.players
      .filter(
        (player) =>
          player.present &&
          player.online &&
          !player.pendingLeaveAfterHand &&
          player.seat !== null &&
          player.chipBalance > 0,
      )
      .sort((left, right) => left.seat! - right.seat!),
  );
}

export function startFirstHand(
  state: TableState,
  input: StartFirstHandInput,
  rng: RandomSource,
): TableState {
  requireHost(state, input.operatorPlayerId);
  if (state.status !== TableLifecycleStatus.WaitingForFirstHand) {
    throw new TableDomainError("First hand can only start from the first-hand waiting state");
  }
  return startTableHand(state, input.handId, input.buttonSeat, rng);
}

export function startNextHand(
  state: TableState,
  input: StartNextHandInput,
  rng: RandomSource,
): TableState {
  requireHost(state, input.operatorPlayerId);
  if (state.status !== TableLifecycleStatus.BetweenHands) {
    throw new TableDomainError("Next hand can only start between completed hands");
  }
  const session = requireActiveSession(state);
  if (session.lastButtonSeat === null) {
    throw new TableDomainError("Previous Button is unavailable");
  }
  const seats = getEligiblePlayers(state).map((player) => player.seat!);
  if (seats.length < 2) throw new TableDomainError("At least two eligible players are required");
  const buttonSeat = moveButton(session.lastButtonSeat, seats) as TableSeat;
  return startTableHand(state, input.handId, buttonSeat, rng);
}

export function applyTableHandAction(state: TableState, command: HandCommand): TableState {
  if (state.status !== TableLifecycleStatus.HandInProgress || state.activeHand === null) {
    throw new TableDomainError("No active hand is waiting for an action");
  }
  return reconcileCompletedHand(state, applyHandAction(state.activeHand, command));
}

export function administrativelyFoldTableParticipant(
  state: TableState,
  input: AdministrativeFoldTableInput,
): TableState {
  if (state.status !== TableLifecycleStatus.HandInProgress || state.activeHand === null) {
    throw new TableDomainError("No active hand is waiting for an administrative Fold");
  }
  return reconcileCompletedHand(
    state,
    administrativelyFoldHandParticipant(state.activeHand, input),
  );
}

export function advanceTableRunout(state: TableState): TableState {
  if (state.status !== TableLifecycleStatus.HandInProgress || state.activeHand === null) {
    throw new TableDomainError("No active hand requires runout advancement");
  }
  return reconcileCompletedHand(state, advanceRunout(state.activeHand));
}

export function revealTableUncontestedWinner(
  state: TableState,
  playerId: PlayerId,
): TableState {
  const opportunity = state.uncontestedRevealOpportunity;
  if (state.status !== TableLifecycleStatus.BetweenHands || opportunity === null) {
    throw new TableDomainError("No uncontested reveal opportunity is available");
  }
  const revealed = revealUncontestedWinner(opportunity.hand, playerId);
  const recentHands = state.recentHands.map((record) =>
    record.sessionId === opportunity.sessionId && record.handNumber === opportunity.handNumber
      ? freezeHandRecord({ ...record, record: getHandRecord(revealed) })
      : record,
  );
  return freezeState({
    ...state,
    uncontestedRevealOpportunity: { ...opportunity, hand: revealed },
    recentHands,
  });
}

export function prepareEndSession(
  state: TableState,
  operatorPlayerId: PlayerId,
): SessionEndPreview {
  requireHost(state, operatorPlayerId);
  const session = requireNonHandSession(state);
  return Object.freeze({
    sessionId: session.sessionId,
    completedHandCount: session.completedHandCount,
    participantPlayerIds: Object.freeze([...session.participantPlayerIds]),
    finalChipBalances: Object.freeze(
      Object.fromEntries(
        session.participantPlayerIds.map((playerId) => [
          playerId,
          requirePlayer(state, playerId).chipBalance,
        ]),
      ),
    ),
  });
}

function confirmationsMatch(
  expected: SessionEndPreview,
  actual: SessionEndPreview,
): boolean {
  return (
    expected.sessionId === actual.sessionId &&
    expected.completedHandCount === actual.completedHandCount &&
    expected.participantPlayerIds.length === actual.participantPlayerIds.length &&
    Object.keys(expected.finalChipBalances).length ===
      Object.keys(actual.finalChipBalances).length &&
    expected.participantPlayerIds.every(
      (playerId, index) =>
        actual.participantPlayerIds[index] === playerId &&
        actual.finalChipBalances[playerId] === expected.finalChipBalances[playerId],
    )
  );
}

export function endSession(state: TableState, input: EndSessionInput): TableState {
  requireHost(state, input.operatorPlayerId);
  const session = requireNonHandSession(state);
  const expected = prepareEndSession(state, input.operatorPlayerId);
  if (!confirmationsMatch(expected, input.confirmation)) {
    throw new TableDomainError("Session end confirmation is stale or does not match");
  }
  return finalizeSession(state, session, input.endMetadata);
}

function finalizeSession(
  state: TableState,
  session: ActiveSession,
  endMetadata: DomainMetadata | undefined,
): TableState {
  const summary = freezeSessionSummary({
    sessionId: session.sessionId,
    participantPlayerIds: session.participantPlayerIds,
    players: session.participantPlayerIds.map((playerId) =>
      sessionPlayerSummary(state, session, playerId),
    ),
    handCount: session.completedHandCount,
    startMetadata: session.startMetadata,
    endMetadata: freezeMetadata(endMetadata),
  });
  return freezeState({
    ...state,
    status: TableLifecycleStatus.SessionEnded,
    players: state.players.map((player) => ({
      ...player,
      seat: null,
      present: false,
      online: false,
      pendingLeaveAfterHand: false,
    })),
    hostPlayerId: null,
    activeHand: null,
    uncontestedRevealOpportunity: null,
    recentSessions: trimToRecent([...state.recentSessions, summary]),
  });
}

/** Trusted lifecycle-only Session end using the same summary accounting path. */
export function autoEndSession(
  state: TableState,
  input: AutoEndSessionInput = {},
): TableState {
  const session = requireNonHandSession(state);
  return finalizeSession(state, session, input.endMetadata);
}
