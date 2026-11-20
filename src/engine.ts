import { parseHttpUrl } from './host.ts';
import { compileIgnore, DEFAULT_IGNORE } from './ignore.ts';
import type { Segment, SegmentationOptions, UrlMode, WindowInfo } from './types.ts';

/** Segmentation options with every default filled in. */
export interface ResolvedSegmentation {
  mergeGapMs: number;
  minSegmentMs: number;
  staleAfterMs: number;
  maxSampleGapMs: number;
  idleAfterSeconds: number;
  urls: UrlMode;
  isIgnored: (window: WindowInfo) => boolean;
}

function nonNegative(name: string, value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new RangeError(`${name} must be a number of at least 0`);
  }
  return value;
}

/** Applies defaults and validates segmentation options. */
export function resolveSegmentation(options: SegmentationOptions = {}): ResolvedSegmentation {
  const urls = options.urls ?? 'host';
  if (urls !== 'host' && urls !== 'full' && urls !== 'none') {
    throw new RangeError("urls must be 'host', 'full' or 'none'");
  }
  return {
    mergeGapMs: nonNegative('mergeGapMs', options.mergeGapMs ?? 2000),
    minSegmentMs: nonNegative('minSegmentMs', options.minSegmentMs ?? 1000),
    staleAfterMs: nonNegative('staleAfterMs', options.staleAfterMs ?? 10_000),
    maxSampleGapMs: nonNegative('maxSampleGapMs', options.maxSampleGapMs ?? 60_000),
    idleAfterSeconds: nonNegative('idleAfterSeconds', options.idleAfterSeconds ?? 50),
    urls,
    isIgnored: compileIgnore(options.ignore ?? DEFAULT_IGNORE),
  };
}

interface Target {
  key: string;
  app: string;
  appId: string;
  host?: string;
  url?: string;
}

interface OpenSegment extends Target {
  startMs: number;
  /** Last time this target was seen in front. */
  seenMs: number;
}

interface ClosedSegment extends Target {
  startMs: number;
  endMs: number;
}

/**
 * The state machine behind `sessionize` and `createTracker`. Feed it samples in time order with
 * `push`, collect finished segments with `drain`, and end it with `finish`.
 */
export class SegmentBuilder {
  readonly #options: ResolvedSegmentation;
  #current: OpenSegment | null = null;
  /** Last closed segment, held back so a same-target gap shorter than `mergeGapMs` can merge into it. */
  #held: ClosedSegment | null = null;
  #ready: Segment[] = [];

  constructor(options: ResolvedSegmentation) {
    this.#options = options;
  }

  /** Processes one sample taken at `at`. */
  push(at: number, window: WindowInfo | null, idleSeconds: number | null): void {
    const options = this.#options;
    const open = this.#current;
    if (open && at - open.seenMs > options.maxSampleGapMs) this.#close(open.seenMs);
    this.#release(at);

    if (idleSeconds != null && Number.isFinite(idleSeconds) && idleSeconds >= options.idleAfterSeconds) {
      // Idle: the segment ends at the last input, not at the moment idle was noticed.
      if (this.#current) this.#close(Math.max(this.#current.startMs, at - idleSeconds * 1000));
      return;
    }

    const target = window ? this.#targetFor(window) : null;
    if (!target) {
      // Nothing usable (no window, or system UI): keep the segment open until it goes stale.
      if (this.#current && at - this.#current.seenMs > options.staleAfterMs) this.#close(this.#current.seenMs);
      return;
    }
    if (this.#current && this.#current.key === target.key) {
      this.#current.seenMs = at;
      return;
    }
    this.#close(at);
    this.#open(target, at);
  }

  /** Delivers the held segment and, with `cut`, the open one, which then continues from `now`. */
  flush(now: number, cut: boolean): Segment[] {
    if (this.#held) {
      this.#deliver(this.#held);
      this.#held = null;
    }
    if (cut && this.#current) {
      this.#deliver({ ...this.#current, endMs: Math.max(this.#current.startMs, now) });
      this.#current = { ...this.#current, startMs: now, seenMs: now };
    }
    return this.drain();
  }

  /** Ends everything at `endMs`, delivers all segments and resets the builder. */
  finish(endMs: number): Segment[] {
    if (this.#held) this.#deliver(this.#held);
    if (this.#current) this.#deliver({ ...this.#current, endMs: Math.max(this.#current.startMs, endMs) });
    this.#held = null;
    this.#current = null;
    return this.drain();
  }

  /** Returns the segments finished since the last call. */
  drain(): Segment[] {
    const out = this.#ready;
    this.#ready = [];
    return out;
  }

  /** Forgets all state without delivering anything. */
  reset(): void {
    this.#current = null;
    this.#held = null;
    this.#ready = [];
  }

  #targetFor(window: WindowInfo): Target | null {
    const app = String(window.app ?? '').trim();
    if (!app || this.#options.isIgnored(window)) return null;
    const appId = String(window.appId ?? '').trim() || app;
    const parsed = this.#options.urls === 'none' ? null : parseHttpUrl(window.url);
    const full = this.#options.urls === 'full' && parsed ? parsed.href : undefined;
    return {
      key: `${appId}|${full ?? parsed?.host ?? ''}`,
      app,
      appId,
      ...(parsed ? { host: parsed.host } : {}),
      ...(full ? { url: full } : {}),
    };
  }

  #release(now: number): void {
    if (this.#held && now - this.#held.endMs >= this.#options.mergeGapMs) {
      this.#deliver(this.#held);
      this.#held = null;
    }
  }

  #close(endMs: number): void {
    const open = this.#current;
    if (!open) return;
    this.#current = null;
    const closed: ClosedSegment = {
      key: open.key,
      app: open.app,
      appId: open.appId,
      ...(open.host ? { host: open.host } : {}),
      ...(open.url ? { url: open.url } : {}),
      startMs: open.startMs,
      endMs: Math.max(open.startMs, endMs),
    };
    // A blip is dropped without touching the held segment, so A, blip, A still merges into one A.
    if (closed.endMs - closed.startMs < this.#options.minSegmentMs) return;
    if (this.#held) this.#deliver(this.#held);
    this.#held = closed;
  }

  #open(target: Target, at: number): void {
    const held = this.#held;
    if (held && held.key === target.key && at - held.endMs < this.#options.mergeGapMs) {
      this.#current = {
        key: held.key,
        app: held.app,
        appId: held.appId,
        ...(held.host ? { host: held.host } : {}),
        ...(held.url ? { url: held.url } : {}),
        startMs: held.startMs,
        seenMs: at,
      };
      this.#held = null;
      return;
    }
    this.#current = { ...target, startMs: at, seenMs: at };
  }

  #deliver(segment: ClosedSegment): void {
    if (segment.endMs - segment.startMs < this.#options.minSegmentMs) return;
    this.#ready.push({
      app: segment.app,
      appId: segment.appId,
      ...(segment.host ? { host: segment.host } : {}),
      ...(segment.url ? { url: segment.url } : {}),
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
  }
}
