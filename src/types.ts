/** What is in front of the user at one moment. */
export interface WindowInfo {
  /** Display name of the application, such as "Google Chrome". */
  app: string;
  /** Stable identifier: macOS bundle id, Windows exe file name or Linux process name. Falls back to `app`. */
  appId?: string;
  /** Window title. Used only by `ignore` predicates; it is never stored in a segment. */
  title?: string;
  /** URL of the active tab when the window is a browser that reports one. */
  url?: string;
}

/** One reading of the active window at a timestamp, plus how long the user had been idle. */
export interface Sample {
  /** Time of the reading, in milliseconds since the Unix epoch. */
  at: number;
  /** The active window, or `null`/`undefined` when nothing could be read. */
  window?: WindowInfo | null;
  /** Seconds since the last keyboard or mouse input, when known. */
  idleSeconds?: number | null;
}

/** A continuous stretch of time spent in one app (and, for browsers, on one website). */
export interface Segment {
  /** Display name of the app. */
  app: string;
  /** Stable app identifier (see `WindowInfo.appId`). */
  appId: string;
  /** Lower-case host of the active tab, such as "github.com". Only set for http(s) URLs. */
  host?: string;
  /** Full URL without the fragment. Only set when the `urls` option is `'full'`. */
  url?: string;
  /** Start time, in milliseconds since the Unix epoch. */
  startMs: number;
  /** End time, in milliseconds since the Unix epoch. */
  endMs: number;
}

/**
 * A rule for windows that should not count as an app. A string matches `appId` or `app` exactly,
 * a RegExp is tested against both, and a function receives the whole window.
 */
export type IgnoreRule = string | RegExp | ((window: WindowInfo) => boolean);

/** What to keep of a browser URL: the host (default), the full URL, or nothing. */
export type UrlMode = 'host' | 'full' | 'none';

/** Options shared by `sessionize` and `createTracker`. */
export interface SegmentationOptions {
  /** Same-target segments closer together than this are merged into one. Default 2000. */
  mergeGapMs?: number;
  /** Segments shorter than this are dropped. Default 1000. */
  minSegmentMs?: number;
  /** An open segment ends at the last sighting once no window has been seen for this long. Default 10000. */
  staleAfterMs?: number;
  /** A gap between samples longer than this (sleep, a frozen process) ends the open segment at the last sighting. Default 60000. */
  maxSampleGapMs?: number;
  /** Idle seconds at which the open segment is cut at the last input. Default 50. */
  idleAfterSeconds?: number;
  /** Windows to ignore, such as system UI. Replaces `DEFAULT_IGNORE` when given. */
  ignore?: readonly IgnoreRule[];
  /** What to keep of browser URLs. Default `'host'`. */
  urls?: UrlMode;
}

/** Options for `sessionize`. */
export interface SessionizeOptions extends SegmentationOptions {
  /** End the last open segment at this time instead of at the last sample. */
  endAt?: number;
}

/** Time source for the tracker. Pass a fake in tests. */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Reads the active window once. Resolve `null` when there is none. */
export type WindowSampler = () => WindowInfo | null | undefined | Promise<WindowInfo | null | undefined>;

/** Reads seconds since the last input, or `null` when unknown. For example `() => powerMonitor.getSystemIdleTime()`. */
export type IdleSource = () => number | null | undefined | Promise<number | null | undefined>;

/** Options for `createTracker`. */
export interface TrackerOptions extends SegmentationOptions {
  /** Reads the active window, for example the result of `getWindowsSampler()`. */
  sample: WindowSampler;
  /** Reads idle seconds. Without it, idle time is not considered. */
  getIdleSeconds?: IdleSource;
  /** Time between polls. Default 2000. */
  intervalMs?: number;
  /** A `sample` call that takes longer than this counts as no window. Default 4000. */
  sampleTimeoutMs?: number;
  /** Receives finished segments, oldest first. Never called with an empty list. */
  onSegments: (segments: Segment[]) => void;
  /** Receives errors from `sample`, `getIdleSeconds` and `onSegments`. Without it they are ignored. */
  onError?: (error: unknown) => void;
  /** Time source. Defaults to the system clock. */
  clock?: Clock;
}

/** Options for `Tracker.flush`. */
export interface FlushOptions {
  /** Also end the open segment now and continue it from this moment. */
  cut?: boolean;
}

/** A running (or stopped) poller. */
export interface Tracker {
  /** Starts polling and takes the first sample immediately. Does nothing when already running. */
  start(): void;
  /** Stops polling and delivers every pending segment, ending the open one at `endMs` (default now). */
  stop(endMs?: number): Segment[];
  /** Delivers segments that are held back for merging and, with `cut`, the open one. */
  flush(options?: FlushOptions): Segment[];
  /** Whether the tracker is polling. */
  isRunning(): boolean;
}

/** How `aggregate` groups segments. */
export type AggregateBy = 'app' | 'host';

/** Options for `aggregate`. */
export interface AggregateOptions {
  /** Group by app (`appId`) or by website host. Segments without a host are skipped for `'host'`. */
  by: AggregateBy;
  /** Count only time at or after this moment (milliseconds since the Unix epoch). */
  from?: number;
  /** Count only time before or at this moment (milliseconds since the Unix epoch). */
  to?: number;
}

/** Total time for one app or host. */
export interface UsageTotal {
  /** `appId` when grouped by app, the host when grouped by host. */
  key: string;
  /** Display name: the app name, or the host. */
  name: string;
  /** Total time in milliseconds, after clipping to `from`/`to`. */
  durationMs: number;
  /** Number of segments that contributed time. */
  segmentCount: number;
}
