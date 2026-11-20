import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTracker } from '../src/index.ts';
import type { Segment, TrackerOptions, WindowInfo } from '../src/index.ts';
import { FakeClock, settle } from './helpers/fake-clock.ts';
import { brief, chrome, code, terminal } from './helpers/samples.ts';

/** A tracker wired to a fake clock, a scripted window and a scripted idle value. */
function setup(overrides: Partial<TrackerOptions> = {}) {
  const clock = new FakeClock();
  const t0 = clock.now();
  const state: { window: WindowInfo | null; idle: number | null; calls: number } = {
    window: code,
    idle: null,
    calls: 0,
  };
  const delivered: Segment[][] = [];
  const errors: unknown[] = [];
  const tracker = createTracker({
    clock,
    sample: () => {
      state.calls += 1;
      return state.window;
    },
    getIdleSeconds: () => state.idle,
    onSegments: (segments) => delivered.push(segments),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  const all = () => delivered.flat();
  /** Delivered segments as seconds after the clock's start. */
  const rel = () =>
    all().map((s) => ({
      appId: s.appId,
      ...(s.host ? { host: s.host } : {}),
      start: (s.startMs - t0) / 1000,
      end: (s.endMs - t0) / 1000,
    }));
  return { clock, state, tracker, delivered, errors, all, rel, t0 };
}

describe('tracker polling', () => {
  it('samples immediately on start and then every intervalMs', async () => {
    const { clock, state, tracker } = setup();
    tracker.start();
    await settle();
    assert.equal(state.calls, 1);
    await clock.advance(2000);
    assert.equal(state.calls, 2);
    await clock.advance(6000);
    assert.equal(state.calls, 5);
    tracker.stop();
  });

  it('uses a custom intervalMs', async () => {
    const { clock, state, tracker } = setup({ intervalMs: 500 });
    tracker.start();
    await clock.advance(2000);
    assert.equal(state.calls, 5);
    tracker.stop();
  });

  it('start is idempotent and reports running state', async () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.isRunning(), false);
    tracker.start();
    tracker.start();
    assert.equal(tracker.isRunning(), true);
    await settle();
    assert.equal(clock.pending, 1);
    tracker.stop();
    assert.equal(tracker.isRunning(), false);
    assert.equal(clock.pending, 0);
  });

  it('does not overlap polls when sample is slower than the interval', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const releases: Array<() => void> = [];
    const tracker = createTracker({
      clock,
      sample: () => {
        calls += 1;
        return new Promise((resolve) => releases.push(() => resolve(code)));
      },
      onSegments: () => {},
      sampleTimeoutMs: 100_000,
    });
    tracker.start();
    await clock.advance(10_000);
    assert.equal(calls, 1);
    releases[0]?.();
    await settle();
    await clock.advance(2000);
    assert.equal(calls, 2);
    tracker.stop();
  });

  it('rejects invalid options', () => {
    const base = { sample: () => null, onSegments: () => {} };
    assert.throws(() => createTracker({ ...base, intervalMs: 0 }), RangeError);
    assert.throws(() => createTracker({ ...base, sampleTimeoutMs: -1 }), RangeError);
    assert.throws(() => createTracker({ ...base, mergeGapMs: -5 }), RangeError);
    assert.throws(() => createTracker({ ...base, sample: undefined as never }), TypeError);
    assert.throws(() => createTracker({ ...base, onSegments: undefined as never }), TypeError);
  });
});

describe('tracker segments', () => {
  it('delivers a segment when the app changes', async () => {
    const { clock, state, tracker, all, rel } = setup();
    tracker.start();
    await clock.advance(10_000);
    state.window = terminal; // seen at the next poll, t=12
    await clock.advance(10_000);
    // The first segment is held back for the merge window, then delivered when the next one closes.
    tracker.stop();
    assert.deepEqual(rel(), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 12 },
      { appId: 'com.apple.Terminal', start: 12, end: 20 },
    ]);
    assert.equal(all().length, 2);
  });

  it('merges a short gap back into the same segment', async () => {
    const { clock, state, tracker, rel } = setup({ minSegmentMs: 2500, mergeGapMs: 3000 });
    tracker.start();
    await clock.advance(6000);
    state.window = terminal;
    await clock.advance(2000); // Terminal is in front for 2 s: shorter than minSegmentMs, so a blip
    state.window = code;
    await clock.advance(6000);
    tracker.stop();
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 14 }]);
  });

  it('takes the host from the browser URL', async () => {
    const { clock, state, tracker, all } = setup();
    state.window = chrome('https://news.ycombinator.com/item?id=1');
    tracker.start();
    await clock.advance(6000);
    tracker.stop();
    assert.equal(all()[0]?.host, 'news.ycombinator.com');
    assert.ok(!JSON.stringify(all()).includes('item?id'));
  });

  it('ignores system UI by default and accepts a custom ignore list', async () => {
    const a = setup();
    a.state.window = { app: 'loginwindow', appId: 'com.apple.loginwindow' };
    a.tracker.start();
    await a.clock.advance(10_000);
    a.tracker.stop();
    assert.deepEqual(a.all(), []);

    const b = setup({ ignore: ['com.microsoft.VSCode'] });
    b.tracker.start();
    await b.clock.advance(10_000);
    b.tracker.stop();
    assert.deepEqual(b.all(), []);
  });

  it('never calls onSegments with an empty list', async () => {
    const { clock, tracker, delivered } = setup();
    tracker.start();
    await clock.advance(500);
    tracker.stop(); // 0.5 s of data is shorter than minSegmentMs
    assert.deepEqual(delivered, []);
  });
});

describe('tracker idle handling', () => {
  it('cuts the segment at the last input when idle starts', async () => {
    const { clock, state, tracker, rel } = setup();
    tracker.start();
    await clock.advance(30_000); // active for 30 s
    // The user stopped typing at t=30 s; the next polls see 2, 4, ... 60 s of idle time.
    for (let i = 1; i <= 30; i++) {
      state.idle = i * 2;
      await clock.advance(2000);
    }
    tracker.stop();
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 30 }]);
  });

  it('starts a new segment when the user comes back', async () => {
    const { clock, state, tracker, rel } = setup();
    tracker.start();
    await clock.advance(30_000);
    for (let i = 1; i <= 30; i++) {
      state.idle = i * 2;
      await clock.advance(2000);
    }
    state.idle = null; // input again at t=90 s
    await clock.advance(10_000);
    tracker.stop();
    assert.deepEqual(rel(), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 30 },
      { appId: 'com.microsoft.VSCode', start: 92, end: 100 },
    ]);
  });

  it('works without getIdleSeconds and survives it throwing', async () => {
    const a = setup({ getIdleSeconds: undefined });
    a.tracker.start();
    await a.clock.advance(6000);
    a.tracker.stop();
    assert.equal(a.all().length, 1);

    const b = setup({
      getIdleSeconds: () => {
        throw new Error('no idle');
      },
    });
    b.tracker.start();
    await b.clock.advance(6000);
    b.tracker.stop();
    assert.equal(b.all().length, 1);
    assert.ok(b.errors.length > 0);
  });

  it('supports an async getIdleSeconds and a custom idleAfterSeconds', async () => {
    const { clock, state, tracker, rel } = setup({
      idleAfterSeconds: 10,
      getIdleSeconds: async () => state.idle,
    });
    tracker.start();
    await clock.advance(20_000);
    state.idle = 12;
    await clock.advance(2000);
    tracker.stop();
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 10 }]);
  });
});

describe('tracker stale windows and errors', () => {
  it('ends the segment at the last sighting when no window is seen for staleAfterMs', async () => {
    const { clock, state, tracker, rel } = setup();
    tracker.start();
    await clock.advance(10_000);
    state.window = null;
    await clock.advance(30_000);
    tracker.stop();
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 10 }]);
  });

  it('treats a sample that times out as no window and reports it', async () => {
    const { clock, errors, tracker, all } = setup({ sample: () => new Promise<null>(() => {}), sampleTimeoutMs: 1000 });
    tracker.start();
    await clock.advance(2500);
    assert.ok(errors.some((e) => e instanceof Error && /longer than 1000 ms/.test(e.message)));
    tracker.stop();
    assert.deepEqual(all(), []);
  });

  it('treats a throwing sample as no window and keeps polling', async () => {
    let n = 0;
    const { clock, errors, tracker, all } = setup({
      sample: () => {
        n += 1;
        if (n === 2) throw new Error('boom');
        return code;
      },
    });
    tracker.start();
    await clock.advance(20_000);
    tracker.stop();
    assert.equal(errors.length, 1);
    assert.deepEqual(
      brief(all()).map((s) => s.appId),
      ['com.microsoft.VSCode'],
    );
  });

  it('routes an onSegments error to onError without stopping the tracker', async () => {
    const { clock, state, errors, tracker } = setup({
      onSegments: () => {
        throw new Error('sink failed');
      },
    });
    tracker.start();
    await clock.advance(6000);
    state.window = terminal;
    await clock.advance(6000);
    state.window = code;
    await clock.advance(6000);
    assert.equal(tracker.isRunning(), true);
    assert.ok(errors.length >= 1);
    tracker.stop();
  });
});

describe('tracker stop and flush', () => {
  it('flushes the open segment on stop, ending it at the stop time', async () => {
    const { clock, tracker, rel, delivered } = setup();
    tracker.start();
    await clock.advance(9000);
    const returned = tracker.stop();
    assert.equal(delivered.length, 1);
    assert.equal(returned.length, 1);
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 9 }]);
  });

  it('ends the open segment at an earlier endMs when given (for example the last tick before sleep)', async () => {
    const { clock, tracker, rel } = setup();
    tracker.start();
    await clock.advance(10_000);
    tracker.stop(clock.now() - 4000);
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 6 }]);
  });

  it('never ends a segment after the current time', async () => {
    const { clock, tracker, rel } = setup();
    tracker.start();
    await clock.advance(10_000);
    tracker.stop(clock.now() + 60_000);
    assert.deepEqual(rel(), [{ appId: 'com.microsoft.VSCode', start: 0, end: 10 }]);
  });

  it('stop on a stopped tracker returns nothing and delivers nothing', async () => {
    const { tracker, delivered } = setup();
    assert.deepEqual(tracker.stop(), []);
    assert.deepEqual(delivered, []);
  });

  it('stops polling', async () => {
    const { clock, state, tracker } = setup();
    tracker.start();
    await clock.advance(4000);
    tracker.stop();
    const calls = state.calls;
    await clock.advance(20_000);
    assert.equal(state.calls, calls);
  });

  it('flush({ cut: true }) delivers the open segment and keeps tracking from that moment', async () => {
    const { clock, tracker, rel } = setup();
    tracker.start();
    await clock.advance(10_000);
    const cut = tracker.flush({ cut: true });
    assert.equal(cut.length, 1);
    await clock.advance(10_000);
    tracker.stop();
    assert.deepEqual(rel(), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 10 },
      { appId: 'com.microsoft.VSCode', start: 10, end: 20 },
    ]);
  });

  it('flush() without cut delivers only segments held back for merging', async () => {
    const { clock, state, tracker, all } = setup();
    tracker.start();
    await clock.advance(10_000);
    state.window = terminal;
    await clock.advance(2000);
    const held = tracker.flush();
    assert.deepEqual(
      held.map((s) => s.appId),
      ['com.microsoft.VSCode'],
    );
    assert.equal(all().length, 1);
    tracker.stop();
  });

  it('can be started again after a stop with clean state', async () => {
    const { clock, tracker, rel } = setup();
    tracker.start();
    await clock.advance(10_000);
    tracker.stop();
    await clock.advance(100_000);
    tracker.start();
    await clock.advance(10_000);
    tracker.stop();
    assert.deepEqual(rel(), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 10 },
      { appId: 'com.microsoft.VSCode', start: 110, end: 120 },
    ]);
  });
});
