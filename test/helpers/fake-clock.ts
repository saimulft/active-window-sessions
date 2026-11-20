import type { Clock } from '../../src/index.ts';

interface Timer {
  at: number;
  callback: () => void;
  every?: number;
}

/** A manual clock: time only moves when `advance` is called, and timers fire in order. */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, Timer>();

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setInterval(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms, callback, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Number of timers that are still scheduled. */
  get pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward, firing due timers and letting their async work finish after each one. */
  async advance(ms: number): Promise<void> {
    await settle();
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | null = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && (nextId === null || timer.at < (this.#timers.get(nextId) as Timer).at)) nextId = id;
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId) as Timer;
      this.#now = Math.max(this.#now, timer.at);
      if (timer.every) timer.at += timer.every;
      else this.#timers.delete(nextId);
      timer.callback();
      await settle();
    }
    this.#now = target;
  }
}

/** Lets pending promise work run to completion. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
