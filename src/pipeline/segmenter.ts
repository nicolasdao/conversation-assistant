import type { AppConfig } from "../config.ts";
import type { StreamName } from "../audio/source.ts";
import { overlaps, type Tag } from "../audio/tags.ts";
import type { JevCallMeta } from "../jev/client.ts";
import { noul, type JevAnswer, type JevResponse, type NoulQuestion, type QuestionSet, type StateUtterance } from "../jev/types.ts";

/** An utterance after transcription and speaker assignment: the unit the segmenter, timeline, and fact-checker share. */
export interface PipelineUtterance {
  id: string;
  stream: StreamName;
  startMs: number;
  endMs: number;
  speakerId: string;
  speakerInferred: boolean;
  text: string;
  filler: boolean;
  failed: boolean;
  tags: Tag[];
  /** The Jev boundary probability, when asked. */
  boundary?: number;
}

export interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  utterances: PipelineUtterance[];
  forced: boolean;
  final: boolean;
}

export interface StreamStatus { stream: StreamName; watermark: number; midSpeech: boolean }

export interface Transcribed {
  speakerId: string;
  speakerInferred: boolean;
  text: string;
  filler: boolean;
  failed: boolean;
  /** Empty text: settled, but never processed. */
  dropped: boolean;
  tags: Tag[];
}

/** What the fact-checker adds to, and takes from, the per-utterance request (§4.8a). */
export interface FactcheckHook {
  questions(): { questions: QuestionSet; version: string };
  onAnswers(u: PipelineUtterance, answers: Record<string, JevAnswer>, context: { segment: PipelineUtterance[] }): void;
}

export interface SegmenterDeps {
  ask(state: unknown, questions: QuestionSet, meta: JevCallMeta): Promise<JevResponse>;
  boundary(): NoulQuestion;
  factcheck: FactcheckHook;
  speakerName(id: string): string;
  /** Follows speaker merges; identity by default. */
  resolveSpeaker?(id: string): string;
  streams(): StreamStatus[];
  onSegmentClosed(s: Segment): void;
  onProcessed?(u: PipelineUtterance): void;
  onError(component: string, message: string, detail?: Record<string, unknown>): void;
  /**
   * False when the session runs with fact-checking and labels both off: Jev is never asked, and a segment closes at a
   * pause of at least `pauseBoundaryMs` instead of on the boundary question. True by default.
   */
  jev?: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

interface Pending {
  id: string;
  stream: StreamName;
  startMs: number;
  endMs: number;
  result?: Transcribed;
  transcribedAt?: number;
}

export function stateUtterance(u: PipelineUtterance, name: (id: string) => string): StateUtterance {
  return { speaker: name(u.speakerId), text: u.text, tags: [...u.tags] };
}

/** Groups utterances into segments with the Jev boundary question plus code rules (§4.7), or with code alone. */
export class Segmenter {
  private readonly pending: Pending[] = [];
  private readonly recent: { stream: StreamName; startMs: number; endMs: number }[] = [];
  private open: Segment | null = null;
  private segN = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => void;

  constructor(private readonly cfg: AppConfig["segmentation"], private readonly deps: SegmenterDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  }

  /** An utterance left the VAD; transcription is in flight. */
  emitted(u: { id: string; stream: StreamName; startMs: number; endMs: number }): void {
    this.pending.push({ id: u.id, stream: u.stream, startMs: u.startMs, endMs: u.endMs });
    this.pending.sort((a, b) => a.startMs - b.startMs);
    this.recent.push({ stream: u.stream, startMs: u.startMs, endMs: u.endMs });
    const horizon = u.startMs - 120_000;
    while (this.recent.length > 0 && this.recent[0].endMs < horizon) this.recent.shift();
  }

  transcribed(id: string, result: Transcribed): void {
    const p = this.pending.find((x) => x.id === id);
    if (!p) return;
    p.result = result;
    p.transcribedAt = this.now();
    this.setTimer(() => this.poll(), this.cfg.reorderTimeoutMs + 1);
    this.poll();
  }

  /** Re-checks the reorder buffer; call on every frame batch, transcription, and timer. */
  poll(): void {
    const streams = this.deps.streams();
    for (let i = 0; i < this.pending.length;) {
      const p = this.pending[i];
      if (!p.result) { i++; continue; }
      const earlierSettled = this.pending.slice(0, i).every((x) => x.result !== undefined);
      const othersSettled = streams.every((s) => s.stream === p.stream || (s.watermark >= p.startMs && !s.midSpeech));
      const timedOut = this.now() - p.transcribedAt! >= this.cfg.reorderTimeoutMs;
      if ((earlierSettled && othersSettled) || timedOut) {
        this.pending.splice(i, 1);
        this.release(p);
      } else {
        i++;
      }
    }
  }

  private release(p: Pending): void {
    const r = p.result!;
    if (r.dropped) return;
    const tags = [...r.tags];
    if (!tags.includes("overlap") && overlaps(p, this.recent)) tags.push("overlap");
    const u: PipelineUtterance = {
      id: p.id, stream: p.stream, startMs: p.startMs, endMs: p.endMs, speakerId: r.speakerId, speakerInferred: r.speakerInferred,
      text: r.text, filler: r.filler, failed: r.failed, tags,
    };
    this.chain = this.chain.then(() => this.process(u)).catch((e) => {
      this.deps.onError("segmenter", e instanceof Error ? e.message : String(e), { utterance_id: u.id });
    });
  }

  /** Resolves when every released utterance has been processed. */
  async idle(): Promise<void> {
    let c: Promise<void>;
    do {
      c = this.chain;
      await c;
    } while (c !== this.chain);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get openSegment(): Segment | null {
    return this.open;
  }

  private span(seg: Segment, u?: PipelineUtterance): number {
    const start = u ? Math.min(seg.startMs, u.startMs) : seg.startMs;
    const end = u ? Math.max(seg.endMs, u.endMs) : seg.endMs;
    return end - start;
  }

  private close(forced: boolean, final = false): Segment | null {
    const seg = this.open;
    if (!seg) return null;
    seg.forced = forced;
    seg.final = final;
    this.open = null;
    this.deps.onSegmentClosed(seg);
    return seg;
  }

  private add(u: PipelineUtterance): void {
    if (!this.open) {
      this.open = { id: `seg_${++this.segN}`, startMs: u.startMs, endMs: u.endMs, utterances: [], forced: false, final: false };
    }
    this.open.utterances.push(u);
    this.open.startMs = Math.min(this.open.startMs, u.startMs);
    this.open.endMs = Math.max(this.open.endMs, u.endMs);
  }

  private async process(u: PipelineUtterance): Promise<void> {
    if (u.failed) {
      // Logged by the transcriber; skips Jev like a filler and adds no text.
      this.deps.onProcessed?.(u);
      return;
    }
    if (u.filler) {
      if (this.open && this.span(this.open, u) > this.cfg.maxSegmentMs) this.close(true);
      this.add(u);
      this.deps.onProcessed?.(u);
      return;
    }

    const useJev = this.deps.jev !== false;
    let answers: Record<string, JevAnswer> | null = null;
    if (useJev) {
      const name = (id: string) => this.deps.speakerName(id);
      const fc = this.deps.factcheck.questions();
      const questions: QuestionSet = { boundary: this.deps.boundary(), ...fc.questions };
      const state = {
        current_segment: (this.open?.utterances ?? []).filter((x) => !x.failed).map((x) => stateUtterance(x, name)),
        new_utterance: stateUtterance(u, name),
      };
      try {
        const res = await this.deps.ask(state, questions, { purpose: "utterance", utterance_id: u.id, question_set_version: fc.version });
        answers = res.answers;
      } catch (e) {
        this.deps.onError("jev", e instanceof Error ? e.message : String(e), { utterance_id: u.id, purpose: "utterance" });
      }
    }
    const boundary = answers ? noul(answers, "boundary") ?? 0 : 0;
    if (useJev) u.boundary = boundary;

    if (this.open) {
      const prev = this.open.utterances[this.open.utterances.length - 1];
      if (this.span(this.open, u) > this.cfg.maxSegmentMs) {
        this.close(true);
      } else if (!useJev) {
        // no Jev: a long enough segment ends at a natural pause
        const gap = prev === undefined ? 0 : u.startMs - prev.endMs;
        if (gap >= this.cfg.pauseBoundaryMs && this.span(this.open) >= this.cfg.minSegmentMs) this.close(false);
      } else {
        const resolve = this.deps.resolveSpeaker ?? ((id: string) => id);
        const speakerChange = prev !== undefined && resolve(prev.speakerId) !== resolve(u.speakerId)
          && u.startMs - prev.endMs >= this.cfg.speakerChangeGapMs;
        const threshold = this.cfg.boundaryThreshold - (speakerChange ? this.cfg.speakerChangeBonus : 0);
        if (boundary >= threshold && this.span(this.open) >= this.cfg.minSegmentMs) this.close(false);
      }
    }
    this.add(u);
    if (answers) this.deps.factcheck.onAnswers(u, answers, { segment: this.open!.utterances });
    this.deps.onProcessed?.(u);
  }

  /** End of input: closes the open segment (forced: false, final: true). Call after idle(). */
  closeFinal(): Segment | null {
    return this.close(false, true);
  }
}
