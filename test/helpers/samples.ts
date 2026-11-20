import type { Sample, WindowInfo } from '../../src/index.ts';

export const T0 = 1_700_000_000_000;

export const code: WindowInfo = { app: 'Code', appId: 'com.microsoft.VSCode', title: 'index.ts' };
export const terminal: WindowInfo = { app: 'Terminal', appId: 'com.apple.Terminal' };
export const chrome = (url?: string): WindowInfo => ({
  app: 'Google Chrome',
  appId: 'com.google.Chrome',
  ...(url ? { url } : {}),
});

/** A sample `seconds` after T0. */
export function at(seconds: number, window: WindowInfo | null, idleSeconds?: number): Sample {
  return { at: T0 + seconds * 1000, window, ...(idleSeconds === undefined ? {} : { idleSeconds }) };
}

/** Samples every `step` seconds from `from` up to and including `to`, all showing `window`. */
export function run(from: number, to: number, window: WindowInfo | null, step = 2): Sample[] {
  const out: Sample[] = [];
  for (let s = from; s <= to; s += step) out.push(at(s, window));
  return out;
}

/** Shortens a segment to seconds after T0 for readable assertions. */
export function brief(segments: Array<{ appId: string; host?: string; startMs: number; endMs: number }>) {
  return segments.map((s) => ({
    appId: s.appId,
    ...(s.host ? { host: s.host } : {}),
    start: (s.startMs - T0) / 1000,
    end: (s.endMs - T0) / 1000,
  }));
}
