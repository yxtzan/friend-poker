import { isDeepStrictEqual } from "node:util";

import {
  AdministrativeFoldReason,
  adjustPlayerChips,
  administrativelyFoldTableParticipant,
  advanceTableRunout,
  applyTableHandAction,
  autoEndSession,
  changeBlinds,
  createTableState,
  endSession,
  enterTable,
  getEligiblePlayers,
  kickPlayer,
  leaveTable,
  PlayerActionType,
  prepareEndSession,
  replenishPlayer,
  revealTableUncontestedWinner,
  seatPlayer,
  setLifecycleHost,
  setPlayerOnline,
  standToSpectate,
  startFirstHand,
  startNextHand,
  startSession,
  transferHost,
} from "@friend-poker/poker-engine";
import type {
  DomainMetadata,
  HandCommand,
  PlayerId,
  TableSeat,
  TableState,
} from "@friend-poker/poker-engine";
import { projectTableState } from "./projection.js";
import {
  CommandRejectionReason,
  RuntimeCommandType,
} from "./types.js";
import type {
  CommandEnvelope,
  CommandExecutionResult,
  CommandExecutionSuccess,
  DuplicateCommandResult,
  RejectedCommandResult,
  RuntimeCommand,
  RuntimeCommandData,
  RuntimeOptions,
  RuntimePokerAction,
  RuntimePrincipal,
  RuntimeProcessedCommandRecord,
  SafeTableProjection,
  TableViewer,
} from "./types.js";

const DEFAULT_PROCESSED_COMMAND_LIMIT = 4_096;
const NO_DATA: RuntimeCommandData = Object.freeze({ kind: "NONE" });
const COMMAND_TYPES = new Set<string>(Object.values(RuntimeCommandType));
const HOST_COMMAND_TYPES = new Set<RuntimeCommand["type"]>([
  RuntimeCommandType.StartSession,
  RuntimeCommandType.StartFirstHand,
  RuntimeCommandType.StartNextHand,
  RuntimeCommandType.HostForceFold,
  RuntimeCommandType.HostAdjustChips,
  RuntimeCommandType.ChangeBlinds,
  RuntimeCommandType.TransferHost,
  RuntimeCommandType.Kick,
  RuntimeCommandType.PrepareEndSession,
  RuntimeCommandType.EndSession,
]);
const SYSTEM_COMMAND_TYPES = new Set<RuntimeCommand["type"]>([
  RuntimeCommandType.SetOnline,
  RuntimeCommandType.AdministrativeFold,
  RuntimeCommandType.AdvanceRunout,
  RuntimeCommandType.SetLifecycleHost,
  RuntimeCommandType.AutoEndSession,
]);

interface ProcessedCommand {
  readonly fingerprint: string;
  readonly principalKey: string;
  readonly originalVersion: number;
  readonly originalStatus: CommandExecutionSuccess["status"];
  readonly data: RuntimeCommandData;
}

interface AppliedCommand {
  readonly state: TableState;
  readonly data: RuntimeCommandData;
}

class InvalidRuntimeCommandError extends Error {}

function trustedFirstHandButton(state: TableState): TableSeat {
  const previousButton = state.session?.lastButtonSeat;
  if (previousButton !== null && previousButton !== undefined) return previousButton;
  const firstEligible = getEligiblePlayers(state)[0]?.seat;
  if (firstEligible === null || firstEligible === undefined) {
    throw new InvalidRuntimeCommandError("No eligible player is available for the first Button");
  }
  return firstEligible;
}

function principalKey(principal: RuntimePrincipal): string {
  return principal.kind === "PLAYER"
    ? `PLAYER:${principal.playerId}`
    : `SYSTEM:${principal.systemId}`;
}

function principalActorId(principal: RuntimePrincipal): string {
  return principal.kind === "PLAYER" ? principal.playerId : principal.systemId;
}

function viewerForPrincipal(principal: RuntimePrincipal): TableViewer {
  return principal.kind === "PLAYER"
    ? Object.freeze({ kind: "PLAYER", playerId: principal.playerId })
    : Object.freeze({ kind: "SPECTATOR" });
}

function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) throw new InvalidRuntimeCommandError("Command must be acyclic");
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => canonicalize(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry, ancestors)]),
      );
  ancestors.delete(value);
  return result;
}

function commandFingerprint(envelope: CommandEnvelope): string {
  return JSON.stringify(
    canonicalize({
      actorId: envelope.actorId,
      expectedVersion: envelope.expectedVersion,
      command: envelope.command,
    }),
  );
}

function snapshotEnvelope(envelope: unknown): unknown {
  return structuredClone(envelope);
}

function isValidEnvelope(envelope: unknown): envelope is CommandEnvelope {
  if (typeof envelope !== "object" || envelope === null) return false;
  const candidate = envelope as Record<string, unknown>;
  const command = candidate.command;
  return (
    typeof candidate.commandId === "string" &&
    candidate.commandId.length > 0 &&
    typeof candidate.actorId === "string" &&
    candidate.actorId.length > 0 &&
    Number.isInteger(candidate.expectedVersion) &&
    (candidate.expectedVersion as number) >= 0 &&
    typeof command === "object" &&
    command !== null &&
    "type" in command &&
    typeof command.type === "string" &&
    COMMAND_TYPES.has(command.type)
  );
}

function pokerCommand(playerId: PlayerId, action: RuntimePokerAction): HandCommand {
  switch (action.type) {
    case PlayerActionType.Fold:
    case PlayerActionType.Check:
    case PlayerActionType.Call:
    case PlayerActionType.AllIn:
      return { playerId, type: action.type };
    case PlayerActionType.Bet:
      return { playerId, type: action.type, amount: action.amount };
    case PlayerActionType.Raise:
      return { playerId, type: action.type, raiseTo: action.raiseTo };
  }
}

function optionalMetadata(input: { readonly metadata?: DomainMetadata }):
  | Record<never, never>
  | { readonly metadata: DomainMetadata } {
  return input.metadata === undefined ? {} : { metadata: input.metadata };
}

export class SingleTableRuntime {
  readonly #rngForHand: RuntimeOptions["rngForHand"];
  readonly #processedCommandLimit: number;
  readonly #processedCommands = new Map<string, ProcessedCommand>();
  #state: TableState;
  #version: number;
  #queue: Promise<void> = Promise.resolve();

  public constructor(options: RuntimeOptions) {
    if (typeof options.rngForHand !== "function") {
      throw new TypeError("rngForHand is required");
    }
    const version = options.initialVersion ?? 0;
    const limit = options.processedCommandLimit ?? DEFAULT_PROCESSED_COMMAND_LIMIT;
    if (!Number.isInteger(version) || version < 0) {
      throw new RangeError("Initial version must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Processed command limit must be a positive integer");
    }
    this.#rngForHand = options.rngForHand;
    this.#processedCommandLimit = limit;
    this.#state = options.initialState ?? createTableState();
    this.#version = version;
    for (const processed of options.initialProcessedCommands ?? []) {
      if (
        processed.commandId.length === 0 ||
        processed.fingerprint.length === 0 ||
        processed.principalKey.length === 0 ||
        !Number.isInteger(processed.originalVersion) ||
        processed.originalVersion < 0
      ) {
        throw new TypeError("Initial processed command record is malformed");
      }
      this.#remember(processed.commandId, {
        fingerprint: processed.fingerprint,
        principalKey: processed.principalKey,
        originalVersion: processed.originalVersion,
        originalStatus: processed.originalStatus,
        data: structuredClone(processed.data),
      });
    }
  }

  public get version(): number {
    return this.#version;
  }

  public getProjection(viewer: TableViewer): SafeTableProjection {
    return projectTableState(this.#state, this.#version, viewer);
  }

  /** Trusted server-internal checkpoint export. Never expose this through transport APIs. */
  public exportDurableCheckpointState(): TableState {
    if (this.#state.activeHand !== null) {
      throw new Error("Cannot export a durable checkpoint while a hand is in progress");
    }
    return structuredClone(this.#state);
  }

  /** Trusted server-internal idempotency lookup used for atomic durable commits. */
  public processedCommandRecord(commandId: string): RuntimeProcessedCommandRecord | null {
    const processed = this.#processedCommands.get(commandId);
    return processed === undefined
      ? null
      : Object.freeze({ commandId, ...structuredClone(processed) });
  }

  public execute(
    principal: RuntimePrincipal,
    envelope: CommandEnvelope,
  ): Promise<CommandExecutionResult> {
    let snapshot: unknown;
    try {
      snapshot = snapshotEnvelope(envelope);
    } catch {
      const commandId =
        typeof envelope === "object" &&
        envelope !== null &&
        "commandId" in envelope &&
        typeof envelope.commandId === "string"
          ? envelope.commandId
          : "INVALID_COMMAND";
      return this.#enqueue(() =>
        this.#reject(
          principal,
          commandId,
          CommandRejectionReason.InvalidCommand,
          "Command envelope could not be copied safely",
        ),
      );
    }
    return this.#enqueue(() => this.#executeSerial(principal, snapshot));
  }

  #enqueue(operation: () => CommandExecutionResult): Promise<CommandExecutionResult> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #executeSerial(
    principal: RuntimePrincipal,
    envelope: unknown,
  ): CommandExecutionResult {
    if (!isValidEnvelope(envelope)) {
      return this.#reject(
        principal,
        typeof envelope === "object" &&
          envelope !== null &&
          "commandId" in envelope &&
          typeof envelope.commandId === "string"
          ? envelope.commandId
          : "INVALID_COMMAND",
        CommandRejectionReason.InvalidCommand,
        "Command envelope is malformed",
      );
    }
    if (principalActorId(principal) !== envelope.actorId) {
      return this.#reject(
        principal,
        envelope.commandId,
        CommandRejectionReason.UnauthorizedIdentity,
        "Bound identity does not match the command actor",
      );
    }

    let fingerprint: string;
    try {
      fingerprint = commandFingerprint(envelope);
    } catch {
      return this.#reject(
        principal,
        envelope.commandId,
        CommandRejectionReason.InvalidCommand,
        "Command payload is not a supported deterministic value",
      );
    }
    const prior = this.#processedCommands.get(envelope.commandId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint || prior.principalKey !== principalKey(principal)) {
        return this.#reject(
          principal,
          envelope.commandId,
          CommandRejectionReason.InvalidCommand,
          "Command ID was already used for a different command",
        );
      }
      return this.#duplicate(principal, envelope.commandId, prior);
    }

    if (envelope.expectedVersion !== this.#version) {
      return this.#reject(
        principal,
        envelope.commandId,
        CommandRejectionReason.StaleVersion,
        "Expected version does not match the authoritative version",
      );
    }
    if (!this.#isAuthorized(principal, envelope.command)) {
      return this.#reject(
        principal,
        envelope.commandId,
        CommandRejectionReason.UnauthorizedIdentity,
        "Actor is not authorized for this command",
      );
    }

    try {
      const applied = this.#applyCommand(envelope.actorId, envelope.command);
      const changed = !isDeepStrictEqual(this.#state, applied.state);
      if (changed) {
        this.#state = applied.state;
        this.#version += 1;
      }
      const success: CommandExecutionSuccess = Object.freeze({
        status: changed ? "APPLIED" : "NO_OP",
        commandId: envelope.commandId,
        version: this.#version,
        data: applied.data,
        projection: this.getProjection(viewerForPrincipal(principal)),
      });
      this.#remember(envelope.commandId, {
        fingerprint,
        principalKey: principalKey(principal),
        originalVersion: success.version,
        originalStatus: success.status,
        data: success.data,
      });
      return success;
    } catch (error) {
      if (error instanceof InvalidRuntimeCommandError) {
        return this.#reject(
          principal,
          envelope.commandId,
          CommandRejectionReason.InvalidCommand,
          error.message,
        );
      }
      return this.#reject(
        principal,
        envelope.commandId,
        CommandRejectionReason.DomainRule,
        error instanceof Error ? error.message : "Domain command was rejected",
      );
    }
  }

  #isAuthorized(principal: RuntimePrincipal, command: RuntimeCommand): boolean {
    if (principal.kind === "SYSTEM") return SYSTEM_COMMAND_TYPES.has(command.type);
    if (SYSTEM_COMMAND_TYPES.has(command.type)) return false;
    if (HOST_COMMAND_TYPES.has(command.type)) {
      return this.#state.hostPlayerId === principal.playerId;
    }
    return true;
  }

  #applyCommand(actorId: string, command: RuntimeCommand): AppliedCommand {
    const playerId = actorId as PlayerId;
    switch (command.type) {
      case RuntimeCommandType.EnterTable:
        return {
          state: enterTable(this.#state, {
            playerId,
            position: command.position,
            ...(command.nickname === undefined ? {} : { nickname: command.nickname }),
            ...(command.online === undefined ? {} : { online: command.online }),
            ...(command.initialGrant === undefined
              ? {}
              : {
                  initialGrant: {
                    ledgerEntryId: command.initialGrant.ledgerEntryId,
                    ...optionalMetadata(command.initialGrant),
                  },
                }),
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.Sit:
        return {
          state: seatPlayer(this.#state, {
            playerId,
            seat: command.seat,
            ...(command.initialGrant === undefined
              ? {}
              : {
                  initialGrant: {
                    ledgerEntryId: command.initialGrant.ledgerEntryId,
                    ...optionalMetadata(command.initialGrant),
                  },
                }),
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.StandToSpectate:
        return { state: standToSpectate(this.#state, playerId), data: NO_DATA };
      case RuntimeCommandType.LeaveTable:
        return { state: leaveTable(this.#state, playerId), data: NO_DATA };
      case RuntimeCommandType.SetOnline:
        return {
          state: setPlayerOnline(this.#state, command.targetPlayerId, command.online),
          data: NO_DATA,
        };
      case RuntimeCommandType.StartSession:
        return {
          state: startSession(this.#state, {
            operatorPlayerId: playerId,
            sessionId: command.sessionId,
            initialGrants: command.initialGrants.map((grant) => ({
              playerId: grant.playerId,
              ledgerEntryId: grant.ledgerEntryId,
              ...optionalMetadata(grant),
            })),
            ...(command.startMetadata === undefined
              ? {}
              : { startMetadata: command.startMetadata }),
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.StartFirstHand:
        return {
          state: startFirstHand(
            this.#state,
            {
              operatorPlayerId: playerId,
              handId: command.handId,
              buttonSeat: command.buttonSeat ?? trustedFirstHandButton(this.#state),
            },
            this.#rngForHand(command.handId),
          ),
          data: NO_DATA,
        };
      case RuntimeCommandType.StartNextHand:
        return {
          state: startNextHand(
            this.#state,
            { operatorPlayerId: playerId, handId: command.handId },
            this.#rngForHand(command.handId),
          ),
          data: NO_DATA,
        };
      case RuntimeCommandType.PokerAction:
        return {
          state: applyTableHandAction(this.#state, pokerCommand(playerId, command.action)),
          data: NO_DATA,
        };
      case RuntimeCommandType.AdministrativeFold:
        return {
          state: administrativelyFoldTableParticipant(this.#state, {
            targetPlayerId: command.targetPlayerId,
            reason: command.reason,
            operatorPlayerId: null,
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.HostForceFold: {
        const participant = this.#state.activeHand?.bettingState.participants.find(
          (candidate) => candidate.playerId === command.targetPlayerId,
        );
        if (
          this.#state.activeHand?.bettingState.currentActorId !== command.targetPlayerId ||
          participant === undefined ||
          participant.folded ||
          participant.allIn
        ) {
          throw new InvalidRuntimeCommandError(
            "Host force Fold requires the current actionable participant",
          );
        }
        return {
          state: administrativelyFoldTableParticipant(this.#state, {
            targetPlayerId: command.targetPlayerId,
            reason: AdministrativeFoldReason.HostForceFold,
            operatorPlayerId: playerId,
          }),
          data: NO_DATA,
        };
      }
      case RuntimeCommandType.AdvanceRunout:
        return { state: advanceTableRunout(this.#state), data: NO_DATA };
      case RuntimeCommandType.RevealUncontested:
        return {
          state: revealTableUncontestedWinner(this.#state, playerId),
          data: NO_DATA,
        };
      case RuntimeCommandType.Replenish:
        return {
          state: replenishPlayer(this.#state, {
            playerId,
            ledgerEntryId: command.ledgerEntryId,
            ...optionalMetadata(command),
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.HostAdjustChips:
        return {
          state: adjustPlayerChips(this.#state, {
            operatorPlayerId: playerId,
            playerId: command.targetPlayerId,
            amount: command.amount,
            ledgerEntryId: command.ledgerEntryId,
            ...optionalMetadata(command),
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.ChangeBlinds:
        return {
          state: changeBlinds(this.#state, {
            operatorPlayerId: playerId,
            smallBlind: command.smallBlind,
            bigBlind: command.bigBlind,
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.TransferHost:
        return {
          state: transferHost(this.#state, {
            operatorPlayerId: playerId,
            targetPlayerId: command.targetPlayerId,
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.SetLifecycleHost:
        return {
          state: setLifecycleHost(this.#state, {
            targetPlayerId: command.targetPlayerId,
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.Kick:
        return {
          state: kickPlayer(this.#state, {
            operatorPlayerId: playerId,
            targetPlayerId: command.targetPlayerId,
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.PrepareEndSession:
        return {
          state: this.#state,
          data: Object.freeze({
            kind: "SESSION_END_PREVIEW",
            preview: prepareEndSession(this.#state, playerId),
          }),
        };
      case RuntimeCommandType.EndSession:
        return {
          state: endSession(this.#state, {
            operatorPlayerId: playerId,
            confirmation: command.confirmation,
            ...(command.endMetadata === undefined
              ? {}
              : { endMetadata: command.endMetadata }),
          }),
          data: NO_DATA,
        };
      case RuntimeCommandType.AutoEndSession:
        return {
          state: autoEndSession(this.#state, {
            ...(command.endMetadata === undefined
              ? {}
              : { endMetadata: command.endMetadata }),
          }),
          data: NO_DATA,
        };
    }
  }

  #remember(commandId: string, processed: ProcessedCommand): void {
    this.#processedCommands.set(commandId, Object.freeze(processed));
    while (this.#processedCommands.size > this.#processedCommandLimit) {
      const oldest = this.#processedCommands.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#processedCommands.delete(oldest);
    }
  }

  #duplicate(
    principal: RuntimePrincipal,
    commandId: string,
    prior: ProcessedCommand,
  ): DuplicateCommandResult {
    return Object.freeze({
      status: "DUPLICATE",
      commandId,
      version: this.#version,
      originalVersion: prior.originalVersion,
      originalStatus: prior.originalStatus,
      data: prior.data,
      projection: this.getProjection(viewerForPrincipal(principal)),
    });
  }

  #reject(
    principal: RuntimePrincipal,
    commandId: string,
    reason: RejectedCommandResult["reason"],
    message: string,
  ): RejectedCommandResult {
    return Object.freeze({
      status: "REJECTED",
      commandId,
      version: this.#version,
      reason,
      message,
      projection: this.getProjection(viewerForPrincipal(principal)),
    });
  }
}
