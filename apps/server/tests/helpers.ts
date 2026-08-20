import {
  HandLifecycleStatus,
  PlayerActionType,
} from "@friend-poker/poker-engine";
import type { PlayerId, RandomSource, TableSeat } from "@friend-poker/poker-engine";
import {
  RuntimeCommandType,
  SingleTableRuntime,
} from "../src/index.js";
import type {
  CommandEnvelope,
  CommandExecutionResult,
  PlayerPrincipal,
  RuntimeCommand,
  RuntimePokerAction,
  RuntimePrincipal,
  SafeTableProjection,
  SystemPrincipal,
} from "../src/index.js";

export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRuntime(): SingleTableRuntime {
  return new SingleTableRuntime({
    rngForHand: (handId) => seededRandom(hashText(handId)),
  });
}

export function playerPrincipal(playerId: PlayerId): PlayerPrincipal {
  return Object.freeze({ kind: "PLAYER", playerId });
}

export const SYSTEM_PRINCIPAL: SystemPrincipal = Object.freeze({
  kind: "SYSTEM",
  systemId: "authoritative-runtime",
});

export class SimulatedClient {
  readonly #runtime: SingleTableRuntime;
  readonly #principal: RuntimePrincipal;
  #sequence = 0;

  public constructor(runtime: SingleTableRuntime, principal: RuntimePrincipal) {
    this.#runtime = runtime;
    this.#principal = principal;
  }

  public get actorId(): string {
    return this.#principal.kind === "PLAYER"
      ? this.#principal.playerId
      : this.#principal.systemId;
  }

  public envelope(
    command: RuntimeCommand,
    options: { readonly commandId?: string; readonly expectedVersion?: number } = {},
  ): CommandEnvelope {
    this.#sequence += 1;
    return Object.freeze({
      commandId: options.commandId ?? `${this.actorId}-${this.#sequence}`,
      actorId: this.actorId,
      expectedVersion: options.expectedVersion ?? this.#runtime.version,
      command,
    });
  }

  public execute(
    command: RuntimeCommand,
    options: { readonly commandId?: string; readonly expectedVersion?: number } = {},
  ): Promise<CommandExecutionResult> {
    return this.#runtime.execute(this.#principal, this.envelope(command, options));
  }

  public replay(envelope: CommandEnvelope): Promise<CommandExecutionResult> {
    return this.#runtime.execute(this.#principal, envelope);
  }

  public projection(): SafeTableProjection {
    return this.#principal.kind === "PLAYER"
      ? this.#runtime.getProjection({
          kind: "PLAYER",
          playerId: this.#principal.playerId,
        })
      : this.#runtime.getProjection({ kind: "SPECTATOR" });
  }
}

export interface RuntimeFixture {
  readonly runtime: SingleTableRuntime;
  readonly clients: Readonly<Record<PlayerId, SimulatedClient>>;
  readonly system: SimulatedClient;
}

export async function seatedRuntime(
  playerIds: readonly PlayerId[] = ["A", "B"],
  seats: readonly TableSeat[] = playerIds.map((_, index) => index as TableSeat),
): Promise<RuntimeFixture> {
  const runtime = createRuntime();
  const clients: Record<PlayerId, SimulatedClient> = {};
  for (let index = 0; index < playerIds.length; index += 1) {
    const playerId = playerIds[index]!;
    const client = new SimulatedClient(runtime, playerPrincipal(playerId));
    clients[playerId] = client;
    const result = await client.execute({
      type: RuntimeCommandType.EnterTable,
      nickname: playerId,
      position: { kind: "SEAT", seat: seats[index]! },
    });
    if (result.status !== "APPLIED") throw new Error(`Could not enter player ${playerId}`);
  }
  return Object.freeze({
    runtime,
    clients: Object.freeze(clients),
    system: new SimulatedClient(runtime, SYSTEM_PRINCIPAL),
  });
}

export async function startedRuntime(
  playerIds: readonly PlayerId[] = ["A", "B"],
  seats?: readonly TableSeat[],
): Promise<RuntimeFixture> {
  const fixture = await seatedRuntime(playerIds, seats);
  const host = fixture.clients[playerIds[0]!]!;
  const result = await host.execute({
    type: RuntimeCommandType.StartSession,
    sessionId: "session-1",
    initialGrants: playerIds.map((playerId) => ({
      playerId,
      ledgerEntryId: `initial-${playerId}`,
    })),
  });
  if (result.status !== "APPLIED") throw new Error("Could not start Session");
  return fixture;
}

export async function startFirstHand(
  fixture: RuntimeFixture,
  handId = "hand-1",
  buttonSeat: TableSeat = 0,
): Promise<void> {
  const result = await fixture.clients.A!.execute({
    type: RuntimeCommandType.StartFirstHand,
    handId,
    buttonSeat,
  });
  if (result.status !== "APPLIED") throw new Error("Could not start first hand");
}

export async function completeWithCallsAndChecks(
  fixture: RuntimeFixture,
): Promise<void> {
  while (fixture.system.projection().currentHand !== null) {
    const projection = fixture.system.projection();
    const hand = projection.currentHand!;
    if (hand.status === HandLifecycleStatus.RunoutRequired) {
      const result = await fixture.system.execute({ type: RuntimeCommandType.AdvanceRunout });
      if (result.status !== "APPLIED") throw new Error("Could not advance runout");
      continue;
    }
    const actorId = hand.currentActorId;
    if (actorId === null) throw new Error("Betting hand has no current actor");
    const actor = hand.participants.find((participant) => participant.playerId === actorId)!;
    const action: RuntimePokerAction =
      actor.streetContribution === hand.currentBet
        ? { type: PlayerActionType.Check }
        : { type: PlayerActionType.Call };
    const result = await fixture.clients[actorId]!.execute({
      type: RuntimeCommandType.PokerAction,
      action,
    });
    if (result.status !== "APPLIED") throw new Error(`Could not act for ${actorId}`);
  }
}

export async function foldUntilComplete(fixture: RuntimeFixture): Promise<void> {
  while (fixture.system.projection().currentHand !== null) {
    const hand = fixture.system.projection().currentHand!;
    if (hand.status === HandLifecycleStatus.RunoutRequired) {
      const result = await fixture.system.execute({ type: RuntimeCommandType.AdvanceRunout });
      if (result.status !== "APPLIED") throw new Error("Could not advance runout");
      continue;
    }
    const actorId = hand.currentActorId;
    if (actorId === null) throw new Error("Betting hand has no current actor");
    const result = await fixture.clients[actorId]!.execute({
      type: RuntimeCommandType.PokerAction,
      action: { type: PlayerActionType.Fold },
    });
    if (result.status !== "APPLIED") throw new Error(`Could not fold ${actorId}`);
  }
}

export function publicProjection(projection: SafeTableProjection) {
  return Object.freeze({
    ...projection,
    ownHoleCards: null,
    viewerLegalActions: null,
    viewerCanRevealUncontested: false,
  });
}
