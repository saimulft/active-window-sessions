# active-window-sessions

Turn active-win and get-windows polling into clean time segments per app and per website.

[![npm version](https://img.shields.io/npm/v/active-window-sessions)](https://www.npmjs.com/package/active-window-sessions)
[![license](https://img.shields.io/npm/l/active-window-sessions)](https://www.npmjs.com/package/active-window-sessions)
[![node](https://img.shields.io/node/v/active-window-sessions)](https://www.npmjs.com/package/active-window-sessions)

Guide, examples and FAQ: https://oss.saimulislam.com/active-window-sessions/

Started as the app-tracking core of the [Staffic](https://staffic.io) desktop app.

[get-windows](https://github.com/sindresorhus/get-windows) and [active-win](https://github.com/sindresorhus/active-win) tell you which window is in front at one moment. Turning a stream of those readings into reliable time segments is left to you: gaps when the window flickers, blips from a notification, time the user was away, and system UI that is not an app. `active-window-sessions` does that part. It merges short gaps, drops blips, cuts a segment at the last input when the user goes idle, ignores system UI, and adds up the totals per app and per website.

The core has no dependencies and takes any `sample` function, so it works with get-windows or anything else that can name the active window.

## Install

```sh
npm install active-window-sessions get-windows
```

get-windows is an optional peer dependency. The core and the macOS helpers import without it; only `getWindowsSampler()` needs it, and it loads it on first use. Node 20 or later, ESM only.

## Example

An Electron main process, using Electron's idle timer:

```ts
import { app, powerMonitor } from 'electron';
import { aggregate, createTracker, getWindowsSampler } from 'active-window-sessions';
import type { Segment } from 'active-window-sessions';

const segments: Segment[] = [];

const tracker = createTracker({
  sample: getWindowsSampler(),
  getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  onSegments: (batch) => segments.push(...batch),
});

app.whenReady().then(() => tracker.start());
powerMonitor.on('suspend', () => tracker.stop());
powerMonitor.on('resume', () => tracker.start());
app.on('before-quit', () => tracker.stop());

// Later, for example for today:
const startOfDay = new Date().setHours(0, 0, 0, 0);
console.log(aggregate(segments, { by: 'app', from: startOfDay }));
console.log(aggregate(segments, { by: 'host', from: startOfDay }));
```

Plain Node works the same way. Node has no idle-time API, so leave out `getIdleSeconds` or supply your own.

`sessionize` runs the same rules over samples you already have. This is real output from the built package:

```js
import { aggregate, sessionize } from 'active-window-sessions';

const t0 = Date.parse('2026-03-02T09:00:00Z');
const at = (seconds, window, idleSeconds) => ({ at: t0 + seconds * 1000, window, idleSeconds });

const code = { app: 'Code', appId: 'com.microsoft.VSCode' };
const chrome = (url) => ({ app: 'Google Chrome', appId: 'com.google.Chrome', url });
const alert = { app: 'UserNotificationCenter', appId: 'com.apple.UserNotificationCenter' };

const samples = [
  at(0, code),
  at(2, code),
  at(4, code),
  at(6, code),
  at(8, chrome('https://github.com/acme/app/pulls')),
  at(10, chrome('https://github.com/acme/app/pulls')),
  at(12, alert), // a system alert flashes in front: ignored
  at(14, chrome('https://github.com/acme/app/issues')),
  at(15, code), // half a second back in the editor: a blip
  at(15.5, chrome('https://github.com/acme/app/issues')),
  at(19, chrome('https://github.com/acme/app/issues'), 0),
  at(70, chrome('https://github.com/acme/app/issues'), 51), // idle for 51 s: the last input was at 19 s
];

const segments = sessionize(samples);
console.log(segments);
console.log(aggregate(segments, { by: 'host' }));
```

```text
console.log(segments)
[
  { app: 'Code', appId: 'com.microsoft.VSCode', startMs: 1772442000000, endMs: 1772442008000 },
  {
    app: 'Google Chrome',
    appId: 'com.google.Chrome',
    host: 'github.com',
    startMs: 1772442008000,
    endMs: 1772442019000
  }
]

console.log(aggregate(segments, { by: 'host' }))
[ { key: 'github.com', name: 'github.com', durationMs: 11000, segmentCount: 1 } ]
```

The alert and the half-second blip did not break the browser segment, the idle period was cut at the last input, and the two GitHub pages became one `github.com` entry. The page paths are gone.

## API

All of these are named exports of `active-window-sessions`.

- `sessionize(samples, options?)` turns `Sample[]` (`{ at, window, idleSeconds }`) into `Segment[]`. Samples are sorted by time first. `options.endAt` ends the last segment at a given time instead of at the last sample.
- `createTracker(options)` returns a tracker with `start()`, `stop(endMs?)`, `flush({ cut? })` and `isRunning()`. It polls `sample`, and delivers finished segments to `onSegments`, oldest first.
  - `stop()` delivers every pending segment and ends the open one at `endMs` (default now, never later).
  - `flush()` delivers segments held back for merging. `flush({ cut: true })` also ends the open segment now and continues it from that moment, which is useful for fixed reporting windows.
  - Errors from `sample`, `getIdleSeconds` and `onSegments` go to `onError` and never stop polling.
- `aggregate(segments, { by, from?, to? })` returns `UsageTotal[]` (`{ key, name, durationMs, segmentCount }`), largest first. `by` is `'app'` (grouped by `appId`) or `'host'` (segments without a host are skipped). `from` and `to` are millisecond timestamps; only the part of a segment inside the range counts.
- `getWindowsSampler(options?)` returns a `sample` function backed by get-windows. Options: `urls`, `accessibilityPermission`, `screenRecordingPermission` (a boolean or a function read before each call), `loadModule`, `platform`.
- `toWindowInfo(result)` converts a get-windows or active-win result into a `WindowInfo`. Use it if you call get-windows yourself.
- `hostFromUrl(url)` returns the lower-case host of an http(s) URL, or `null`.
- `DEFAULT_IGNORE` is the default ignore list (macOS system UI). Extend it with `ignore: [...DEFAULT_IGNORE, 'My Overlay']`.
- `checkPlatformSupport(options?)` reports whether active-window reading can work: Linux needs X11 with `xprop` and `xwininfo`.
- `defaultIdleThresholdSeconds(options?)` and `isRemoteSession(options?)` suggest an `idleAfterSeconds` (50, or 30 on a remote session).
- `systemClock` is the default `Clock`. Pass your own `clock` to the tracker to control time in tests.

Types are exported for every option and result: `WindowInfo`, `Sample`, `Segment`, `SegmentationOptions`, `SessionizeOptions`, `TrackerOptions`, `Tracker`, `FlushOptions`, `AggregateOptions`, `UsageTotal`, `IgnoreRule`, `UrlMode`, `Clock`, `WindowSampler`, `IdleSource`, `WindowsSamplerOptions`, `PlatformOptions`, `PlatformSupport`.

### Options shared by `sessionize` and `createTracker`

| Option             | Default   | Meaning                                                                                                                                                                   |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeGapMs`       | `2000`    | Segments of the same target closer together than this become one.                                                                                                         |
| `minSegmentMs`     | `1000`    | Shorter segments are dropped.                                                                                                                                             |
| `staleAfterMs`     | `10000`   | An open segment ends at its last sighting once no window has been seen for this long.                                                                                     |
| `maxSampleGapMs`   | `60000`   | A longer silence between samples (sleep, a frozen process) ends the open segment.                                                                                         |
| `idleAfterSeconds` | `50`      | At this much idle time the open segment is cut at the last input.                                                                                                         |
| `ignore`           | system UI | Rules for windows that are not apps. A string matches `appId` or `app` exactly, a `RegExp` is tested against both, a function gets the window. Replaces the default list. |
| `urls`             | `'host'`  | `'host'` keeps the host, `'full'` keeps the URL without its fragment, `'none'` keeps neither.                                                                             |

Tracker only: `sample` (required), `onSegments` (required), `getIdleSeconds`, `intervalMs` (`2000`), `sampleTimeoutMs` (`4000`; a slower sample counts as no window), `onError`, `clock`. The tracker's default `maxSampleGapMs` is the larger of `60000` and three intervals.

## How segmenting works

Each sample is a window plus, optionally, how long the user has been idle. The rules run in this order.

1. **Sample gaps.** If more than `maxSampleGapMs` passed since the last sample, the open segment ends at the last sighting. Without this, a laptop that sleeps for an hour would log an hour in the app that was in front.
2. **Idle.** When idle time reaches `idleAfterSeconds`, the open segment ends at the last input (`now - idle`), not when idle was noticed. No segment opens while the user is idle.
3. **Ignored and missing windows.** System UI and missing readings do not end a segment right away. The segment stays open and ends at its last sighting once nothing has been seen for `staleAfterMs`. A notification that flashes up in front of your editor does not split it.
4. **Switching.** When the target changes (a different app, or a different host in the same browser), the open segment ends at the first sample of the new target.
5. **Merging.** A closed segment is held back for `mergeGapMs`. If the same target comes back inside that gap, the two become one segment that covers the gap.
6. **Blips.** A segment shorter than `minSegmentMs` is dropped. A blip between two stretches of the same target does not stop them merging, as long as the whole gap is shorter than `mergeGapMs`.

The target is the app (`appId`) plus, for browsers, the host. Pages on the same host share a target. With `urls: 'full'` each page is its own target.

## macOS permissions

`active-window-sessions/macos` has helpers for the three macOS permissions that window tracking runs into: Accessibility, Screen Recording, and Automation (Apple Events) per browser. They take Electron's `systemPreferences` and a command runner as arguments, so nothing runs until you call it and you can test with fakes.

```ts
import { app, desktopCapturer, shell, systemPreferences } from 'electron';
import { getWindowsSampler } from 'active-window-sessions';
import { createMacPermissions } from 'active-window-sessions/macos';

// Create it once the app is ready: the Screen Recording state at that moment
// decides whether a later grant needs a relaunch.
const permissions = createMacPermissions({
  systemPreferences,
  openExternal: (url) => shell.openExternal(url),
  requestScreenRecording: () =>
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }),
  relaunch: () => {
    app.relaunch();
    app.quit();
  },
});

// Ask get-windows only for what is granted, so it returns what it can instead of failing.
const sample = getWindowsSampler({
  accessibilityPermission: () => permissions.accessibilityState() === 'granted',
  screenRecordingPermission: () => permissions.screenState() === 'granted',
});

const view = await permissions.getView(); // for a permissions screen
// { supported: true, permissions: { accessibility, screen, automation: { [bundleId]: state } }, browsers, needsRelaunch }
```

- `accessibilityState()` and `screenState()` read the state without prompting.
- `getPermissions({ probe?, fresh? })` returns all states. Automation is probed with `osascript` through your command runner, once per browser, and the answer is cached for `automationCacheMs` (10 s) so a 2-second re-check does not repeat the macOS prompt. `fresh: true` probes again; `probe: false` reads cached answers only. A browser that is not running keeps its last real answer, because the probe never launches it.
- `getView()` adds the browser list and `needsRelaunch`: macOS applies a Screen Recording grant only after a restart, so it is `true` once Screen Recording was granted or requested after the app launched without it.
- `request(kind, bundleId?)` shows the prompt where macOS has one (`'accessibility'`, `'screen'`, or `'automation'` for one browser). A refusal can only be undone in System Settings: `openSettings(kind)` opens the right pane through your `openExternal`.
- `runCommand` defaults to `execFile`. Pass your own `(command, args, { timeoutMs }) => Promise<{ stdout, stderr, exitCode }>` to change that or to test.
- The browser list comes from `MAC_BROWSERS` filtered by installed apps. Pass `browsers` to set it yourself.

Off macOS these helpers do nothing: `getPermissions()` returns `null` and the state functions return `'granted'`.

## Privacy

This library reads which app and, for browsers, which site is in front of the user, and records when. Tell the people you track what you track.

- A segment holds the app name, an app identifier, the host of a browser URL (for example `github.com`), and start and end times. Paths, query strings and fragments are dropped before anything is stored. `urls: 'full'` keeps the path and query; `urls: 'none'` keeps no URL data at all.
- Window titles are read but never stored. They are only passed to your own `ignore` functions.
- It never captures screen contents. macOS asks for Screen Recording because get-windows needs it to read other apps' window titles.
- Nothing leaves the process unless your `onSegments` sends it. The library makes no network requests, writes no files and has no telemetry.

## Limits

- It is polling. Segment edges are only as accurate as `intervalMs` (2 s by default), and a window that comes and goes between two polls is not seen.
- Only the front window counts. Background tabs, a second monitor, and audio or meeting activity are not detected.
- Browser URLs come from get-windows, which reads them on macOS only, for the browsers it supports, and only with Accessibility and per-browser Automation granted. Everywhere else a browser is just an app with no host.
- Linux works on X11 with `xprop` and `xwininfo` installed. Wayland has no active-window API.
- Hosts are lower-cased but not otherwise normalised: `www.example.com` and `example.com` are different hosts.
- Idle time comes from the function you pass. Without `getIdleSeconds`, a user who walks away is counted as active until the window changes or goes stale.
- The default ignore list covers macOS system UI only. Add rules for other platforms' overlays.
- `aggregate` assumes segments do not overlap. Segments from one tracker never do; if you merge several sources, deduplicate first.
- get-windows is never called by this package's tests. The adapter and the macOS helpers are tested against fakes shaped like their real inputs, so check them on a real machine before you rely on them.
- get-windows is loaded with a dynamic `import()` whose name is a variable. If you bundle your app, mark `get-windows` as external.

## License

MIT © Saimul Islam
