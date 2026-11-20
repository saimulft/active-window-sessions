import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate } from '../src/index.ts';
import type { Segment } from '../src/index.ts';
import { T0 } from './helpers/samples.ts';

const seg = (appId: string, startS: number, endS: number, host?: string, app = appId): Segment => ({
  app,
  appId,
  ...(host ? { host } : {}),
  startMs: T0 + startS * 1000,
  endMs: T0 + endS * 1000,
});

const segments: Segment[] = [
  seg('com.google.Chrome', 0, 60, 'github.com', 'Google Chrome'),
  seg('com.microsoft.VSCode', 60, 180, undefined, 'Code'),
  seg('com.google.Chrome', 180, 210, 'docs.example.com', 'Google Chrome'),
  seg('com.google.Chrome', 210, 300, 'github.com', 'Google Chrome'),
  seg('com.google.Chrome', 300, 310, undefined, 'Google Chrome'),
];

describe('aggregate by app', () => {
  it('sums time per app, largest first', () => {
    assert.deepEqual(aggregate(segments, { by: 'app' }), [
      { key: 'com.google.Chrome', name: 'Google Chrome', durationMs: 190_000, segmentCount: 4 },
      { key: 'com.microsoft.VSCode', name: 'Code', durationMs: 120_000, segmentCount: 1 },
    ]);
  });

  it('returns an empty list for no segments', () => {
    assert.deepEqual(aggregate([], { by: 'app' }), []);
  });

  it('breaks ties by key so the order is stable', () => {
    const tied = [seg('b', 0, 10), seg('a', 10, 20)];
    assert.deepEqual(
      aggregate(tied, { by: 'app' }).map((t) => t.key),
      ['a', 'b'],
    );
  });
});

describe('aggregate by host', () => {
  it('sums time per website and skips segments without a host', () => {
    assert.deepEqual(aggregate(segments, { by: 'host' }), [
      { key: 'github.com', name: 'github.com', durationMs: 150_000, segmentCount: 2 },
      { key: 'docs.example.com', name: 'docs.example.com', durationMs: 30_000, segmentCount: 1 },
    ]);
  });
});

describe('from/to clipping', () => {
  it('counts only the part of a segment inside the range', () => {
    const totals = aggregate(segments, { by: 'app', from: T0 + 30_000, to: T0 + 90_000 });
    assert.deepEqual(
      totals.map((t) => [t.key, t.durationMs]),
      [
        ['com.google.Chrome', 30_000],
        ['com.microsoft.VSCode', 30_000],
      ],
    );
  });

  it('drops segments entirely outside the range', () => {
    assert.deepEqual(aggregate(segments, { by: 'host', from: T0 + 400_000 }), []);
    assert.deepEqual(aggregate(segments, { by: 'host', to: T0 - 1 }), []);
  });

  it('clips with only from, or only to', () => {
    assert.equal(aggregate(segments, { by: 'host', from: T0 + 30_000 })[0]?.durationMs, 120_000);
    assert.equal(aggregate(segments, { by: 'host', to: T0 + 30_000 })[0]?.durationMs, 30_000);
  });

  it('does not count a segment that only touches the range edge', () => {
    assert.deepEqual(aggregate(segments, { by: 'app', from: T0 + 310_000 }), []);
  });

  it('counts a segment that spans the whole range for the range length', () => {
    const [total] = aggregate([seg('x', 0, 1000)], { by: 'app', from: T0 + 100_000, to: T0 + 160_000 });
    assert.equal(total?.durationMs, 60_000);
  });
});

describe('aggregate input checks', () => {
  it('rejects an unknown grouping', () => {
    assert.throws(() => aggregate(segments, { by: 'title' as never }), RangeError);
  });

  it('does not change the segments it is given', () => {
    const copy = structuredClone(segments);
    aggregate(segments, { by: 'host', from: T0 + 1, to: T0 + 5000 });
    assert.deepEqual(segments, copy);
  });
});
