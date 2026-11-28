## 0.1.2

- The README is now a visual tour: a picture of the package at work, the guide, npm, GitHub and changelog links, and a See it work section. No code changes.

## 0.1.1

- Clearer npm description and keywords, and a homepage with a guide, examples and FAQ: https://oss.saimulislam.com/active-window-sessions/

## 0.1.0

Initial release

- `sessionize` turns timestamped samples into segments: merges short gaps, drops blips, cuts at the last input when idle starts, ends stale windows, and skips system UI.
- `createTracker` polls any `sample` function on an interval with the same rules, with start, stop and flush, an injectable clock and error reporting.
- `aggregate` totals segments per app or per website host, clipped to a `from`/`to` range.
- `getWindowsSampler` reads the active window through get-windows, which is an optional peer dependency loaded on first use.
- `active-window-sessions/macos` has injectable helpers for Accessibility, Screen Recording and per-browser Automation, with probe caching and a relaunch-needed flag.
- Only the host of a browser URL is stored by default; window titles are never stored.
