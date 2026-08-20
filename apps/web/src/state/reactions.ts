import {
  REACTION_MAX_SUCCESSFUL,
  REACTION_WINDOW_MS,
} from "@friend-poker/shared";

export interface ReactionAttemptResult {
  readonly accepted: boolean;
  readonly showEgg: boolean;
}

/** Local UX guard; the server applies the same policy independently. */
export class ReactionRateLimiter {
  #timestamps: number[] = [];
  #cooldownUntil = 0;

  public attempt(now = Date.now()): ReactionAttemptResult {
    this.#timestamps = this.#timestamps.filter(
      (timestamp) => timestamp > now - REACTION_WINDOW_MS,
    );
    if (this.#cooldownUntil > now) return { accepted: false, showEgg: false };
    if (this.#timestamps.length >= REACTION_MAX_SUCCESSFUL) {
      this.#cooldownUntil = now + REACTION_WINDOW_MS;
      return { accepted: false, showEgg: true };
    }
    this.#timestamps.push(now);
    return { accepted: true, showEgg: false };
  }
}
