import {
  REACTION_MAX_SUCCESSFUL,
  REACTION_WINDOW_MS,
} from "@friend-poker/shared";

interface ReactionWindow {
  timestamps: number[];
  cooldownUntil: number;
}

export interface ReactionRateLimiterOptions {
  readonly now?: () => number;
}

/** Server-side spam guard for the fixed, non-persistent reaction channel. */
export class ReactionRateLimiter {
  readonly #windows = new Map<string, ReactionWindow>();
  readonly #now: () => number;

  public constructor(options: ReactionRateLimiterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  public tryAccept(playerId: string, now = this.#now()): boolean {
    const window = this.#windows.get(playerId) ?? { timestamps: [], cooldownUntil: 0 };
    window.timestamps = window.timestamps.filter(
      (timestamp) => timestamp > now - REACTION_WINDOW_MS,
    );
    if (window.cooldownUntil > now) {
      this.#windows.set(playerId, window);
      return false;
    }
    if (window.timestamps.length >= REACTION_MAX_SUCCESSFUL) {
      window.cooldownUntil = now + REACTION_WINDOW_MS;
      this.#windows.set(playerId, window);
      return false;
    }
    window.timestamps.push(now);
    this.#windows.set(playerId, window);
    return true;
  }

  public clear(playerId: string): void {
    this.#windows.delete(playerId);
  }

  public clearAll(): void {
    this.#windows.clear();
  }
}
