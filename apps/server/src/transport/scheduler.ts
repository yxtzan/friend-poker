export type LifecycleTimerHandle = object;

export interface LifecycleScheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): LifecycleTimerHandle;
  cancel(handle: LifecycleTimerHandle): void;
}

export class SystemLifecycleScheduler implements LifecycleScheduler {
  public now(): number {
    return Date.now();
  }

  public schedule(delayMs: number, callback: () => void): LifecycleTimerHandle {
    return setTimeout(callback, delayMs);
  }

  public cancel(handle: LifecycleTimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
