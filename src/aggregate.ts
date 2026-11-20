import type { AggregateOptions, Segment, UsageTotal } from './types.ts';

/**
 * Adds up segment time per app or per website host, largest first. With `from` and `to`, only the
 * part of each segment inside that range counts. Segments are expected not to overlap.
 */
export function aggregate(segments: readonly Segment[], options: AggregateOptions): UsageTotal[] {
  if (options.by !== 'app' && options.by !== 'host') throw new RangeError("by must be 'app' or 'host'");
  const from = options.from ?? -Infinity;
  const to = options.to ?? Infinity;
  const totals = new Map<string, UsageTotal>();
  for (const segment of segments) {
    const key = options.by === 'app' ? segment.appId : segment.host;
    if (!key) continue;
    const durationMs = Math.min(segment.endMs, to) - Math.max(segment.startMs, from);
    if (!(durationMs > 0)) continue;
    const total = totals.get(key) ?? {
      key,
      name: options.by === 'app' ? segment.app : key,
      durationMs: 0,
      segmentCount: 0,
    };
    total.durationMs += durationMs;
    total.segmentCount += 1;
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => b.durationMs - a.durationMs || a.key.localeCompare(b.key));
}
