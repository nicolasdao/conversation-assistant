import { rmsDbfs } from "./tags.ts";
import { SAMPLE_RATE } from "./wav.ts";

/** Where the Mac plays the call, as the capture helper reports it. */
export type OutputKind = "speakers" | "headphones" | "virtual";

export interface EchoGateConfig {
  /** `auto`: on while a live session plays through speakers. `always`: every session, replays included. `never`: off. */
  mode: "auto" | "always" | "never";
  /** A call frame at or above this level counts as the call playing. */
  thresholdDbfs: number;
  /** How long the microphone stays muted after the call goes quiet: room echo and the speakers' own delay. */
  holdMs: number;
}

/**
 * A mute never reaches further ahead of the host frame than this. Frames are merged in session-time order, so a call
 * frame is at most one frame (32 ms) ahead of the host frame; a larger lead means the clocks disagree, and the gate lets
 * the microphone through rather than silence it on a bad timestamp.
 */
const MAX_LEAD_MS = 1000;

/**
 * Speaker mode: when the call plays through the Mac's speakers, the microphone hears the guests too, and their words would
 * be transcribed a second time as the host's. While the gate is active, every host frame is replaced by silence while the
 * call (the remote stream) is playing and for `holdMs` after. The call's audio reaches the tap before its echo reaches the
 * microphone, and frames are merged in session-time order, so the gate is already closed when the echo arrives.
 *
 * Inactive, it returns every frame unchanged: with earbuds the pipeline is exactly as without it.
 *
 * It holds no "muted" state that could be left on: each host frame is judged on its own, against the time of the last
 * loud call frame. When the call goes quiet, stops, or its stream ends, the microphone is back within holdMs.
 */
export class EchoGate {
  active: boolean;
  /** Session time at which the call last stopped playing. */
  private playingUntilMs = -Infinity;
  /** Host milliseconds muted since the last read, for the health meter. */
  private mutedMs = 0;

  constructor(private readonly cfg: EchoGateConfig) {
    this.active = cfg.mode === "always";
  }

  /** Follows the output device (auto mode only); returns true when that changes whether the gate is active. */
  setOutput(kind: OutputKind | null): boolean {
    if (this.cfg.mode !== "auto") return false;
    const next = kind === "speakers";
    if (next === this.active) return false;
    this.active = next;
    if (!next) this.mutedMs = 0;
    return true;
  }

  /** A remote (call) frame: notes whether the call is playing. */
  remote(samples: Float32Array, sessionMs: number): void {
    if (rmsDbfs(samples) >= this.cfg.thresholdDbfs) this.playingUntilMs = sessionMs + (samples.length * 1000) / SAMPLE_RATE;
  }

  /** A host (microphone) frame: silence while the call plays and for holdMs after, otherwise the frame itself. */
  host(samples: Float32Array, sessionMs: number): Float32Array {
    if (!this.active || sessionMs >= this.playingUntilMs + this.cfg.holdMs) return samples;
    if (this.playingUntilMs - sessionMs > MAX_LEAD_MS) return samples; // a call timestamp far ahead: never mute on it
    this.mutedMs += (samples.length * 1000) / SAMPLE_RATE;
    return new Float32Array(samples.length);
  }

  /** Milliseconds of microphone muted since the last call. */
  takeMutedMs(): number {
    const ms = this.mutedMs;
    this.mutedMs = 0;
    return Math.round(ms);
  }
}
