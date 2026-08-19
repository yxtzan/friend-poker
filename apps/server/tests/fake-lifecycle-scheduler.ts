import type {
  LifecycleScheduler,
  LifecycleTimerHandle,
} from "../src/index.js";

interface FakeTask extends LifecycleTimerHandle {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class FakeLifecycleScheduler implements LifecycleScheduler {
  #now = 0;
  #sequence = 0;
  readonly #tasks = new Set<FakeTask>();
  readonly #cancelledCallbacks: (() => void)[] = [];

  public now(): number {
    return this.#now;
  }

  public schedule(delayMs: number, callback: () => void): LifecycleTimerHandle {
    const task: FakeTask = {
      id: ++this.#sequence,
      dueAt: this.#now + delayMs,
      callback,
      cancelled: false,
    };
    this.#tasks.add(task);
    return task;
  }

  public cancel(handle: LifecycleTimerHandle): void {
    const task = handle as FakeTask;
    task.cancelled = true;
    this.#tasks.delete(task);
    this.#cancelledCallbacks.push(task.callback);
  }

  public advanceBy(delayMs: number): void {
    this.advanceTo(this.#now + delayMs);
  }

  public advanceTo(targetTime: number): void {
    if (targetTime < this.#now) throw new RangeError("Fake time cannot move backwards");
    while (true) {
      const next = [...this.#tasks]
        .filter((task) => !task.cancelled && task.dueAt <= targetTime)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (next === undefined) break;
      this.#tasks.delete(next);
      this.#now = next.dueAt;
      if (!next.cancelled) next.callback();
    }
    this.#now = targetTime;
  }

  public get pendingCount(): number {
    return [...this.#tasks].filter((task) => !task.cancelled).length;
  }

  /** Emulates a callback already queued by the host event loop when cancellation races. */
  public fireCancelledCallbacks(): void {
    const callbacks = this.#cancelledCallbacks.splice(0);
    for (const callback of callbacks) callback();
  }
}
