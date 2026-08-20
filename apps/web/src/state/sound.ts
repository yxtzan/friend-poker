import type { ReactionEmoji } from "@friend-poker/shared";

export type TableSound = "TURN" | "STREET" | "ACK" | "COMPLETE";

interface ToneShape {
  readonly frequency: number;
  readonly duration: number;
  readonly waveform?: OscillatorType;
  readonly volume?: number;
}

const SOUND_SHAPES: Record<TableSound, ToneShape> = {
  TURN: { frequency: 660, duration: 0.12 },
  STREET: { frequency: 520, duration: 0.16 },
  ACK: { frequency: 440, duration: 0.07 },
  COMPLETE: { frequency: 360, duration: 0.2 },
};

export interface ReactionSoundCue {
  readonly frequencies: readonly number[];
  readonly duration: number;
  readonly waveform: OscillatorType;
  readonly volume: number;
}

export const REACTION_SOUND_CUES = {
  "😂": { frequencies: [480, 720, 560], duration: 0.18, waveform: "triangle", volume: 0.024 },
  "😎": { frequencies: [700, 560], duration: 0.16, waveform: "sine", volume: 0.022 },
  "😭": { frequencies: [430, 300], duration: 0.24, waveform: "sine", volume: 0.02 },
  "🤔": { frequencies: [430, 650], duration: 0.2, waveform: "triangle", volume: 0.021 },
  "🔥": { frequencies: [360, 580, 860], duration: 0.15, waveform: "triangle", volume: 0.023 },
  "👏": { frequencies: [190, 260], duration: 0.12, waveform: "triangle", volume: 0.022 },
} as const satisfies Readonly<Record<ReactionEmoji, ReactionSoundCue>>;

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
    const now = context.currentTime;
    this.#playTone(context, shape, now);
    void context.resume().catch(() => undefined);
  }

  public playReaction(emoji: ReactionEmoji): void {
    if (!this.#unlocked || typeof window === "undefined") return;
    const context = this.#getContext();
    if (context === null) return;
    const cue = REACTION_SOUND_CUES[emoji];
    const now = context.currentTime;
    const spacing = cue.frequencies.length > 1
      ? cue.duration / (cue.frequencies.length + 1)
      : 0;
    for (const [index, frequency] of cue.frequencies.entries()) {
      this.#playTone(
        context,
        {
          frequency,
          duration: Math.min(0.11, cue.duration * 0.58),
          waveform: cue.waveform,
          volume: cue.volume,
        },
        now + index * spacing,
      );
    }
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

  #playTone(context: AudioContext, shape: ToneShape, startAt: number): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const volume = shape.volume ?? 0.045;
    oscillator.type = shape.waveform ?? "sine";
    oscillator.frequency.setValueAtTime(shape.frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + shape.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + shape.duration + 0.02);
  }
}
