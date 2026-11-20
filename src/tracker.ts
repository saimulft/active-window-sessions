import { resolveSegmentation, SegmentBuilder } from './engine.ts';
import type { Clock, FlushOptions, Segment, Tracker, TrackerOptions, WindowInfo } from './types.ts';

/** The system clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Polls `sample` on an interval and turns the readings into segments, delivered to `onSegments`.
 * Create it, call `start()`, and call `stop()` to deliver what is left.
 */
export function createTracker(options: TrackerOptions): Tracker {
  const { sample, getIdleSeconds, onSegments, onError } = options;
  if (typeof sample !== 'function') throw new TypeError('sample must be a function');
  if (typeof onSegments !== 'function') throw new TypeError('onSegments must be a function');
  const intervalMs = options.intervalMs ?? 2000;
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) throw new RangeError('intervalMs must be greater than 0');
  const sampleTimeoutMs = options.sampleTimeoutMs ?? 4000;
  if (!(sampleTimeoutMs > 0)) throw new RangeError('sampleTimeoutMs must be greater than 0');
  const clock = options.clock ?? systemClock;
  const builder = new SegmentBuilder(
    resolveSegmentation({ ...options, maxSampleGapMs: options.maxSampleGapMs ?? Math.max(60_000, intervalMs * 3) }),
  );

  let timer: unknown = null;
  let running = false;
  let inFlight = false;
  /** Bumped on every start so a poll that began before a restart cannot write into the new run. */
  let run = 0;

  const report = (error: unknown): void => {
    try {
      onError?.(error);
    } catch {
      // An error handler that throws must not break polling.
    }
  };

  const deliver = (segments: Segment[]): Segment[] => {
    if (segments.length > 0) {
      try {
        onSegments(segments);
      } catch (error) {
        report(error);
      }
    }
    return segments;
  };

  async function readWindow(): Promise<WindowInfo | null> {
    let timeoutHandle: unknown = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = clock.setTimeout(() => resolve('timeout'), sampleTimeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(sample), timeout]);
      if (result === 'timeout') {
        report(new Error(`sample took longer than ${sampleTimeoutMs} ms`));
        return null;
      }
      return result ?? null;
    } catch (error) {
      report(error);
      return null;
    } finally {
      clock.clearTimeout(timeoutHandle);
    }
  }

  async function readIdle(): Promise<number | null> {
    if (!getIdleSeconds) return null;
    try {
      return (await getIdleSeconds()) ?? null;
    } catch (error) {
      report(error);
      return null;
    }
  }

  async function poll(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    const thisRun = run;
    try {
      const window = await readWindow();
      if (!running || thisRun !== run) return;
      const idleSeconds = await readIdle();
      if (!running || thisRun !== run) return;
      builder.push(clock.now(), window, idleSeconds);
      deliver(builder.drain());
    } catch (error) {
      report(error);
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      run += 1;
      builder.reset();
      timer = clock.setInterval(() => void poll(), intervalMs);
      void poll();
    },
    stop(endMs) {
      if (!running) return [];
      running = false;
      clock.clearInterval(timer);
      timer = null;
      const now = clock.now();
      return deliver(builder.finish(Math.min(endMs ?? now, now)));
    },
    flush(flushOptions: FlushOptions = {}) {
      return deliver(builder.flush(clock.now(), Boolean(flushOptions.cut) && running));
    },
    isRunning: () => running,
  };
}
