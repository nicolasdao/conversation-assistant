import type { AppConfig } from "../config.ts";

export interface QueueItem {
  claimId: string;
  priority: number;
  /** Wall-clock ms when the claim was flagged. */
  flaggedAt: number;
}

export type DropReason = "stale" | "session_cap" | "stopped";

export interface QueueDeps {
  research(item: QueueItem): Promise<void>;
  onDropped(item: QueueItem, reason: DropReason): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

const HOUR_MS = 3_600_000;

/** Highest priority first, served by researchConcurrency workers, within the per-hour and per-session caps (§4.8b). */
export class ResearchQueue {
  private readonly items: QueueItem[] = [];
  private readonly starts: number[] = [];
  private started = 0;
  private active = 0;
  private stopped = false;
  private timerArmed = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => void;

  constructor(private readonly cfg: AppConfig["s2"], private readonly deps: QueueDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  }

  enqueue(item: QueueItem): void {
    if (this.stopped) {
      this.deps.onDropped(item, "stopped");
      return;
    }
    this.items.push(item);
    this.pump();
  }

  get size(): number {
    return this.items.length;
  }

  get researching(): number {
    return this.active;
  }

  get researchedCount(): number {
    return this.started;
  }

  private next(): QueueItem | undefined {
    if (this.items.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i];
      const b = this.items[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.flaggedAt < b.flaggedAt)) best = i;
    }
    return this.items.splice(best, 1)[0];
  }

  /** Drops stale items; starts research while workers and caps allow. */
  pump(): void {
    const now = this.now();
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (now - this.items[i].flaggedAt > this.cfg.staleAfterMs) this.deps.onDropped(this.items.splice(i, 1)[0], "stale");
    }
    while (this.starts.length > 0 && now - this.starts[0] >= HOUR_MS) this.starts.shift();
    while (this.active < this.cfg.researchConcurrency && this.items.length > 0) {
      if (this.started >= this.cfg.maxResearchPerSession) {
        for (const it of this.items.splice(0)) this.deps.onDropped(it, "session_cap");
        return;
      }
      if (this.starts.length >= this.cfg.maxResearchPerHour) {
        // Wait for the hour window to free a slot; items may go stale meanwhile.
        this.arm(Math.min(HOUR_MS - (now - this.starts[0]), this.cfg.staleAfterMs));
        return;
      }
      const item = this.next()!;
      this.active++;
      this.started++;
      this.starts.push(now);
      const p = this.deps.research(item)
        .catch(() => { /* the research callback reports its own errors */ })
        .finally(() => {
          this.active--;
          this.inflight.delete(p);
          this.pump();
        });
      this.inflight.add(p);
    }
    if (this.items.length > 0) this.arm(this.cfg.staleAfterMs);
  }

  private arm(ms: number) {
    if (this.timerArmed) return;
    this.timerArmed = true;
    this.setTimer(() => {
      this.timerArmed = false;
      this.pump();
    }, Math.max(1, ms));
  }

  /** Resolves when nothing is queued or in flight. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Stops accepting work and drops what is queued. */
  stop(): void {
    this.stopped = true;
    for (const it of this.items.splice(0)) this.deps.onDropped(it, "stopped");
  }
}
