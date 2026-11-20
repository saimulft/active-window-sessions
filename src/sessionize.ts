import { resolveSegmentation, SegmentBuilder } from './engine.ts';
import type { Sample, Segment, SessionizeOptions } from './types.ts';

/**
 * Turns timestamped samples into segments: merges short gaps, drops blips, cuts at the last input
 * when idle starts, and skips system UI. Samples may arrive in any order; they are sorted by time.
 */
export function sessionize(samples: readonly Sample[], options: SessionizeOptions = {}): Segment[] {
  const builder = new SegmentBuilder(resolveSegmentation(options));
  const ordered = samples.filter((sample) => Number.isFinite(sample.at)).sort((a, b) => a.at - b.at);
  const last = ordered.at(-1);
  if (!last) return [];
  for (const sample of ordered) builder.push(sample.at, sample.window ?? null, sample.idleSeconds ?? null);
  return builder.finish(options.endAt ?? last.at);
}
