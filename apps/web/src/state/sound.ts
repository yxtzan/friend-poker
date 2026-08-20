export type TableSound = "TURN" | "STREET" | "ACK" | "COMPLETE";

const SOUND_SHAPES: Record<TableSound, { readonly frequency: number; readonly duration: number }> = {
  TURN: { frequency: 660, duration: 0.12 },
  STREET: { frequency: 520, duration: 0.16 },
  ACK: { frequency: 440, duration: 0.07 },
  COMPLETE: { frequency: 360, duration: 0.2 },
};

/** Small Web Audio tones; no asset, loop, music, or autoplay is involved. */
export class TableSoundPlayer {
  #context: AudioContext | null = null;
  #unlocked = false;

  public unlock(): void {
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") return;
    this.#unlocked = true;
    const context = this.#getContext();
    void context?.resume().catch(() => undefined);
  }

  public play(kind: TableSound): void {
    if (!this.#unlocked || typeof window === "undefined") return;
    const context = this.#getContext();
    if (context === null) return;
    const shape = SOUND_SHAPES[kind];
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(shape.frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + shape.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + shape.duration + 0.02);
    void context.resume().catch(() => undefined);
  }

  public dispose(): void {
    const context = this.#context;
    this.#context = null;
    this.#unlocked = false;
    if (context !== null) void context.close().catch(() => undefined);
  }

  #getContext(): AudioContext | null {
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
    this.#context ??= new window.AudioContext();
    return this.#context;
  }
}
