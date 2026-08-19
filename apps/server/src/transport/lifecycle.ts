import {
  AdministrativeFoldReason,
  HandLifecycleStatus,
  TableLifecycleStatus,
} from "@friend-poker/poker-engine";
import type { PlayerId } from "@friend-poker/poker-engine";

import { RuntimeCommandType } from "../runtime/types.js";
import type {
  CommandExecutionResult,
  RuntimeCommand,
  SafeTableProjection,
} from "../runtime/types.js";
import type { SingleTableRuntime } from "../runtime/runtime.js";
import type { LifecycleScheduler, LifecycleTimerHandle } from "./scheduler.js";

export const DEFAULT_DISCONNECTED_TURN_TIMEOUT_MS = 60_000;
export const DEFAULT_HOST_DISCONNECT_GRACE_MS = 60_000;
export const DEFAULT_ALL_OFFLINE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_RUNOUT_STAGE_DELAY_MS = 750;

interface OwnedTimer {
  readonly handle: LifecycleTimerHandle;
  readonly key: string;
}

export interface LifecycleControllerOptions {
  readonly runtime: SingleTableRuntime;
  readonly scheduler: LifecycleScheduler;
  readonly executeSystem: (command: RuntimeCommand) => Promise<CommandExecutionResult>;
  readonly broadcast: () => void;
  readonly onSessionEnded: () => void;
  readonly disconnectedTurnTimeoutMs?: number;
  readonly hostDisconnectGraceMs?: number;
  readonly allOfflineTimeoutMs?: number;
  readonly runoutStageDelayMs?: number;
}

function activeSession(projection: SafeTableProjection): boolean {
  return (
    projection.status !== TableLifecycleStatus.NoSession &&
    projection.status !== TableLifecycleStatus.SessionEnded
  );
}

export class LifecycleController {
  readonly #runtime: SingleTableRuntime;
  readonly #scheduler: LifecycleScheduler;
  readonly #executeSystem: LifecycleControllerOptions["executeSystem"];
  readonly #broadcast: () => void;
  readonly #onSessionEnded: () => void;
  readonly #disconnectedTurnTimeoutMs: number;
  readonly #hostDisconnectGraceMs: number;
  readonly #allOfflineTimeoutMs: number;
  readonly #runoutStageDelayMs: number;
  readonly #onlineSince = new Map<PlayerId, number>();
  #turnTimer: OwnedTimer | null = null;
  #hostTimer: OwnedTimer | null = null;
  #allOfflineTimer: OwnedTimer | null = null;
  #runoutTimer: OwnedTimer | null = null;
  #pendingAutoEnd = false;
  #handledEndedSessionId: string | null = null;
  #closed = false;
  #queue: Promise<void> = Promise.resolve();

  public constructor(options: LifecycleControllerOptions) {
    this.#runtime = options.runtime;
    this.#scheduler = options.scheduler;
    this.#executeSystem = options.executeSystem;
    this.#broadcast = options.broadcast;
    this.#onSessionEnded = options.onSessionEnded;
    this.#disconnectedTurnTimeoutMs =
      options.disconnectedTurnTimeoutMs ?? DEFAULT_DISCONNECTED_TURN_TIMEOUT_MS;
    this.#hostDisconnectGraceMs =
      options.hostDisconnectGraceMs ?? DEFAULT_HOST_DISCONNECT_GRACE_MS;
    this.#allOfflineTimeoutMs =
      options.allOfflineTimeoutMs ?? DEFAULT_ALL_OFFLINE_TIMEOUT_MS;
    this.#runoutStageDelayMs =
      options.runoutStageDelayMs ?? DEFAULT_RUNOUT_STAGE_DELAY_MS;
  }

  public playerConnected(playerId: PlayerId): Promise<void> {
    if (!this.#onlineSince.has(playerId)) this.#onlineSince.set(playerId, this.#scheduler.now());
    return this.reconcile();
  }

  public playerDisconnected(playerId: PlayerId): Promise<void> {
    this.#onlineSince.delete(playerId);
    return this.reconcile();
  }

  public reconcile(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const result = this.#queue.then(() => this.#reconcileNow());
    this.#queue = result.catch(() => undefined);
    return result;
  }

  public settled(): Promise<void> {
    return this.#queue;
  }

  public close(): void {
    this.#closed = true;
    this.#cancelTurn();
    this.#cancelHost();
    this.#cancelAllOffline();
    this.#cancelRunout();
    this.#onlineSince.clear();
  }

  async #reconcileNow(): Promise<void> {
    if (this.#closed) return;
    let projection = this.#projection();
    if (projection.status === TableLifecycleStatus.SessionEnded) {
      this.#cancelTurn();
      this.#cancelAllOffline();
      this.#cancelRunout();
      this.#pendingAutoEnd = false;
      const sessionId = projection.session?.sessionId ?? null;
      if (sessionId !== this.#handledEndedSessionId) {
        this.#cancelHost();
        this.#handledEndedSessionId = sessionId;
        this.#onlineSince.clear();
        this.#onSessionEnded();
        return;
      }
      const hasNewGatheringPlayers =
        projection.seats.some((player) => player?.present === true) ||
        projection.spectators.some((player) => player.present);
      if (!hasNewGatheringPlayers) {
        this.#cancelHost();
        return;
      }
    } else {
      this.#handledEndedSessionId = null;
    }

    projection = await this.#reconcileHost(projection);
    this.#reconcileAllOffline(projection);
    if (
      this.#pendingAutoEnd &&
      activeSession(projection) &&
      projection.status !== TableLifecycleStatus.HandInProgress
    ) {
      await this.#applySystem({
        type: RuntimeCommandType.AutoEndSession,
        endMetadata: { reason: "ALL_OFFLINE_TIMEOUT" },
      });
      await this.#reconcileNow();
      return;
    }
    this.#reconcileTurn(projection);
    this.#reconcileRunout(projection);
  }

  async #reconcileHost(projection: SafeTableProjection): Promise<SafeTableProjection> {
    const hostId = projection.hostPlayerId;
    if (hostId === null) {
      this.#cancelHost();
      const candidate = this.#electHost(projection);
      if (candidate !== null) {
        await this.#applySystem({
          type: RuntimeCommandType.SetLifecycleHost,
          targetPlayerId: candidate,
        });
        return this.#projection();
      }
      return projection;
    }
    if (this.#onlineSince.has(hostId)) {
      this.#cancelHost();
      return projection;
    }
    const key = hostId;
    if (this.#hostTimer?.key === key) return projection;
    this.#cancelHost();
    this.#hostTimer = this.#scheduleOwned(
      key,
      this.#hostDisconnectGraceMs,
      async () => {
        this.#hostTimer = null;
        const current = this.#projection();
        if (current.hostPlayerId !== hostId || this.#onlineSince.has(hostId)) return;
        await this.#applySystem({
          type: RuntimeCommandType.SetLifecycleHost,
          targetPlayerId: this.#electHost(current),
        });
        await this.#reconcileNow();
      },
    );
    return projection;
  }

  #electHost(projection: SafeTableProjection): PlayerId | null {
    const compare = (left: PlayerId, right: PlayerId): number => {
      const timeDifference = this.#onlineSince.get(left)! - this.#onlineSince.get(right)!;
      return timeDifference === 0 ? left.localeCompare(right) : timeDifference;
    };
    const seated = projection.seats
      .filter((player): player is NonNullable<typeof player> => player !== null)
      .filter((player) => player.present && player.online && this.#onlineSince.has(player.playerId))
      .map((player) => player.playerId)
      .sort(compare);
    if (seated[0] !== undefined) return seated[0];
    const spectators = projection.spectators
      .filter((player) => player.present && player.online && this.#onlineSince.has(player.playerId))
      .map((player) => player.playerId)
      .sort(compare);
    return spectators[0] ?? null;
  }

  #reconcileTurn(projection: SafeTableProjection): void {
    const hand = projection.currentHand;
    const actorId = hand?.currentActorId ?? null;
    const participant = hand?.participants.find((candidate) => candidate.playerId === actorId);
    if (
      hand?.status !== HandLifecycleStatus.Betting ||
      actorId === null ||
      participant === undefined ||
      participant.folded ||
      participant.allIn ||
      this.#onlineSince.has(actorId)
    ) {
      this.#cancelTurn();
      return;
    }
    const key = `${hand.handId}:${actorId}`;
    if (this.#turnTimer?.key === key) return;
    this.#cancelTurn();
    this.#turnTimer = this.#scheduleOwned(
      key,
      this.#disconnectedTurnTimeoutMs,
      async () => {
        this.#turnTimer = null;
        const current = this.#projection();
        const currentParticipant = current.currentHand?.participants.find(
          (candidate) => candidate.playerId === actorId,
        );
        if (
          current.currentHand?.handId !== hand.handId ||
          current.currentHand.status !== HandLifecycleStatus.Betting ||
          current.currentHand.currentActorId !== actorId ||
          currentParticipant === undefined ||
          currentParticipant.folded ||
          currentParticipant.allIn ||
          this.#onlineSince.has(actorId)
        ) {
          await this.#reconcileNow();
          return;
        }
        await this.#applySystem({
          type: RuntimeCommandType.AdministrativeFold,
          targetPlayerId: actorId,
          reason: AdministrativeFoldReason.DisconnectTimeout,
        });
        await this.#reconcileNow();
      },
    );
  }

  #reconcileRunout(projection: SafeTableProjection): void {
    const hand = projection.currentHand;
    if (hand?.status !== HandLifecycleStatus.RunoutRequired) {
      this.#cancelRunout();
      return;
    }
    const key = hand.handId;
    if (this.#runoutTimer?.key === key) return;
    this.#cancelRunout();
    this.#runoutTimer = this.#scheduleOwned(key, this.#runoutStageDelayMs, async () => {
      this.#runoutTimer = null;
      const current = this.#projection();
      if (
        current.currentHand?.handId !== hand.handId ||
        current.currentHand.status !== HandLifecycleStatus.RunoutRequired
      ) {
        await this.#reconcileNow();
        return;
      }
      await this.#applySystem({ type: RuntimeCommandType.AdvanceRunout });
      await this.#reconcileNow();
    });
  }

  #reconcileAllOffline(projection: SafeTableProjection): void {
    if (!activeSession(projection) || this.#onlineSince.size > 0) {
      this.#pendingAutoEnd = false;
      this.#cancelAllOffline();
      return;
    }
    const key = projection.session!.sessionId;
    if (this.#allOfflineTimer?.key === key || this.#pendingAutoEnd) return;
    this.#allOfflineTimer = this.#scheduleOwned(key, this.#allOfflineTimeoutMs, async () => {
      this.#allOfflineTimer = null;
      const current = this.#projection();
      if (!activeSession(current) || this.#onlineSince.size > 0) {
        await this.#reconcileNow();
        return;
      }
      if (current.status === TableLifecycleStatus.HandInProgress) {
        this.#pendingAutoEnd = true;
        await this.#reconcileNow();
        return;
      }
      await this.#applySystem({
        type: RuntimeCommandType.AutoEndSession,
        endMetadata: { reason: "ALL_OFFLINE_TIMEOUT" },
      });
      await this.#reconcileNow();
    });
  }

  async #applySystem(command: RuntimeCommand): Promise<void> {
    const result = await this.#executeSystem(command);
    if (result.status === "APPLIED") this.#broadcast();
  }

  #projection(): SafeTableProjection {
    return this.#runtime.getProjection({ kind: "SPECTATOR" });
  }

  #scheduleOwned(key: string, delayMs: number, callback: () => Promise<void>): OwnedTimer {
    const handle = this.#scheduler.schedule(delayMs, () => {
      if (this.#closed) return;
      const result = this.#queue.then(async () => {
        if (this.#closed) return;
        await callback();
      });
      this.#queue = result.catch(() => undefined);
    });
    return Object.freeze({ key, handle });
  }

  #cancel(timer: OwnedTimer | null): void {
    if (timer !== null) this.#scheduler.cancel(timer.handle);
  }

  #cancelTurn(): void {
    this.#cancel(this.#turnTimer);
    this.#turnTimer = null;
  }

  #cancelHost(): void {
    this.#cancel(this.#hostTimer);
    this.#hostTimer = null;
  }

  #cancelAllOffline(): void {
    this.#cancel(this.#allOfflineTimer);
    this.#allOfflineTimer = null;
  }

  #cancelRunout(): void {
    this.#cancel(this.#runoutTimer);
    this.#runoutTimer = null;
  }
}
