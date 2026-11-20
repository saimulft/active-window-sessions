import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_IGNORE, sessionize } from '../src/index.ts';
import { at, brief, chrome, code, run, T0, terminal } from './helpers/samples.ts';

describe('sessionize basics', () => {
  it('returns nothing for no samples', () => {
    assert.deepEqual(sessionize([]), []);
  });

  it('turns one app into one segment from the first to the last sample', () => {
    const segments = sessionize(run(0, 10, code));
    assert.deepEqual(brief(segments), [{ appId: 'com.microsoft.VSCode', start: 0, end: 10 }]);
    assert.equal(segments[0]?.app, 'Code');
  });

  it('cuts a new segment when the app changes, at the first sample of the new app', () => {
    const segments = sessionize([...run(0, 6, code), ...run(8, 14, terminal)]);
    assert.deepEqual(brief(segments), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 8 },
      { appId: 'com.apple.Terminal', start: 8, end: 14 },
    ]);
  });

  it('sorts unordered samples and ignores samples with an invalid time', () => {
    const shuffled = [at(4, code), at(0, code), { at: Number.NaN, window: terminal }, at(2, code)];
    assert.deepEqual(brief(sessionize(shuffled)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 4 }]);
  });

  it('ends the last segment at endAt when given', () => {
    const segments = sessionize(run(0, 4, code), { endAt: T0 + 9000 });
    assert.deepEqual(brief(segments), [{ appId: 'com.microsoft.VSCode', start: 0, end: 9 }]);
  });

  it('falls back to the app name when there is no appId', () => {
    const segments = sessionize([at(0, { app: 'Notes' }), at(4, { app: 'Notes' })]);
    assert.equal(segments[0]?.appId, 'Notes');
  });

  it('never stores the window title', () => {
    const segments = sessionize(run(0, 4, { app: 'Code', title: 'secret-plans.md' }));
    assert.ok(!JSON.stringify(segments).includes('secret-plans'));
  });

  it('skips windows without an app name', () => {
    assert.deepEqual(sessionize(run(0, 10, { app: '  ' })), []);
  });
});

describe('gap merging', () => {
  it('merges the same app when the gap is shorter than mergeGapMs', () => {
    // code 0-4, terminal 4-5 is 1 s (kept only as a blip below), then code again at 5.
    const samples = [at(0, code), at(2, code), at(4, code), at(4.5, terminal), at(5, code), at(7, code)];
    const segments = sessionize(samples, { minSegmentMs: 1000 });
    assert.deepEqual(brief(segments), [{ appId: 'com.microsoft.VSCode', start: 0, end: 7 }]);
  });

  it('merges across a short stretch with no window at all', () => {
    const samples = [at(0, code), at(2, code), at(4, null), at(6, code), at(8, code)];
    // No window for 2 s is below staleAfterMs, so the segment simply continues.
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 8 }]);
  });

  it('merges a short gap left by an app switch away and back', () => {
    const samples = [...run(0, 4, code), at(5, terminal), at(5.9, code), at(8, code)];
    const segments = sessionize(samples, { minSegmentMs: 1000 });
    assert.deepEqual(brief(segments), [{ appId: 'com.microsoft.VSCode', start: 0, end: 8 }]);
  });

  it('keeps segments apart when the other app was in front for at least mergeGapMs', () => {
    const samples = [...run(0, 4, code), ...run(6, 10, terminal), ...run(12, 16, code)];
    assert.equal(sessionize(samples).length, 3);
  });

  it('respects a custom mergeGapMs', () => {
    const samples = [...run(0, 4, code), ...run(6, 8, terminal), ...run(10, 14, code)];
    assert.equal(sessionize(samples, { mergeGapMs: 0 }).length, 3);
    // A real visit to another app is never bridged, however large the merge gap is.
    assert.equal(sessionize(samples, { mergeGapMs: 60_000 }).length, 3);
  });

  it('does not merge different websites in the same browser', () => {
    const samples = [...run(0, 4, chrome('https://github.com/a')), ...run(6, 10, chrome('https://docs.example.com/x'))];
    assert.deepEqual(brief(sessionize(samples)), [
      { appId: 'com.google.Chrome', host: 'github.com', start: 0, end: 6 },
      { appId: 'com.google.Chrome', host: 'docs.example.com', start: 6, end: 10 },
    ]);
  });
});

describe('blip dropping', () => {
  it('drops a segment shorter than minSegmentMs', () => {
    const samples = [...run(0, 6, code), at(8, terminal), at(8.4, code), ...run(12, 20, code)];
    // The 0.4 s Terminal visit disappears and the two Code stretches become one.
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 20 }]);
  });

  it('keeps a segment of exactly minSegmentMs', () => {
    const samples = [at(0, code), at(1, terminal), at(10, terminal)];
    assert.deepEqual(brief(sessionize(samples)), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 1 },
      { appId: 'com.apple.Terminal', start: 1, end: 10 },
    ]);
    assert.equal(sessionize([at(0, code), at(0.999, terminal), at(10, terminal)]).length, 1);
  });

  it('drops everything when no segment reaches minSegmentMs', () => {
    assert.deepEqual(sessionize([at(0, code), at(0.5, code)]), []);
  });

  it('respects a custom minSegmentMs', () => {
    const samples = [at(0, code), at(3, terminal), at(10, terminal)];
    const strict = sessionize(samples, { minSegmentMs: 5000 });
    assert.deepEqual(brief(strict), [{ appId: 'com.apple.Terminal', start: 3, end: 10 }]);
  });
});

describe('idle', () => {
  it('cuts the segment at the last input when idle starts', () => {
    // At t=100 the user has been idle for 60 s, so the last input was at t=40.
    const samples = [...run(0, 40, code), ...run(42, 98, code), at(100, code, 60)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 40 }]);
  });

  it('does not cut when idle time is below the threshold', () => {
    const samples = [...run(0, 20, code), at(22, code, 49)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 22 }]);
  });

  it('cuts exactly at the threshold', () => {
    const samples = [...run(0, 58, code), at(60, code, 50)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 10 }]);
  });

  it('respects a custom idleAfterSeconds', () => {
    const samples = [...run(0, 28, code), at(30, code, 20)];
    assert.deepEqual(brief(sessionize(samples, { idleAfterSeconds: 15 })), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 10 },
    ]);
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 30 }]);
  });

  it('starts a new segment when the user returns after idle', () => {
    const samples = [
      ...run(0, 20, code),
      at(80, code, 60), // last input at t=20
      at(82, code, 62),
      at(200, code, 0), // back at the keyboard
      at(202, code, 0),
      at(204, code, 0),
    ];
    const segments = sessionize(samples, { maxSampleGapMs: 1_000_000 });
    assert.deepEqual(brief(segments), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 20 },
      { appId: 'com.microsoft.VSCode', start: 200, end: 204 },
    ]);
  });

  it('opens nothing while idle, even if a window is in front', () => {
    assert.deepEqual(sessionize([at(0, code, 300), at(2, code, 302), at(4, code, 304)]), []);
  });

  it('ignores idle values that are not numbers', () => {
    const samples = [at(0, code), at(2, code, Number.NaN), at(4, code)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 4 }]);
  });
});

describe('stale windows and sample gaps', () => {
  it('ends a segment at the last sighting once no window is seen for staleAfterMs', () => {
    const samples = [...run(0, 6, code), at(8, null), at(10, null), at(12, null), at(17, null)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 6 }]);
  });

  it('keeps the segment while the window is missing for less than staleAfterMs', () => {
    const samples = [...run(0, 6, code), at(8, null), at(10, null), at(12, code)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 12 }]);
  });

  it('respects a custom staleAfterMs', () => {
    const samples = [...run(0, 6, code), at(8, null), at(10, null), at(12, code)];
    assert.deepEqual(brief(sessionize(samples, { staleAfterMs: 2000 })), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 6 },
    ]);
  });

  it('treats undefined and missing windows like null', () => {
    const samples = [at(0, code), { at: T0 + 2000 }, { at: T0 + 4000, window: undefined }, at(6, code)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 6 }]);
  });

  it('splits when samples stop for longer than maxSampleGapMs (sleep)', () => {
    const samples = [...run(0, 10, code), ...run(3600, 3610, code)];
    assert.deepEqual(brief(sessionize(samples)), [
      { appId: 'com.microsoft.VSCode', start: 0, end: 10 },
      { appId: 'com.microsoft.VSCode', start: 3600, end: 3610 },
    ]);
  });

  it('does not split on a long gap when maxSampleGapMs is raised', () => {
    const samples = [at(0, code), at(120, code)];
    assert.equal(sessionize(samples, { maxSampleGapMs: 300_000 }).length, 1);
    assert.deepEqual(sessionize(samples), []);
  });
});

describe('ignore list', () => {
  const loginWindow = { app: 'loginwindow', appId: 'com.apple.loginwindow' };
  const notification = { app: 'UserNotificationCenter', appId: 'com.apple.UserNotificationCenter' };

  it('exports a default list that covers the macOS system UI', () => {
    for (const id of [
      'com.apple.loginwindow',
      'com.apple.notificationcenterui',
      'com.apple.controlcenter',
      'ScreenSaverEngine',
    ]) {
      assert.ok(DEFAULT_IGNORE.includes(id), id);
    }
  });

  it('never creates segments for system UI', () => {
    assert.deepEqual(sessionize(run(0, 20, loginWindow)), []);
    assert.deepEqual(sessionize(run(0, 20, notification)), []);
  });

  it('matches by display name when the id is missing', () => {
    assert.deepEqual(sessionize(run(0, 20, { app: 'loginwindow' })), []);
  });

  it('does not break the segment when system UI flashes in front', () => {
    const samples = [...run(0, 6, code), at(8, notification), at(10, code), at(12, code)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 12 }]);
  });

  it('ends the segment once system UI has covered the app for longer than staleAfterMs', () => {
    const samples = [...run(0, 6, code), ...run(8, 30, loginWindow)];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.microsoft.VSCode', start: 0, end: 6 }]);
  });

  it('accepts custom string, RegExp and function rules, replacing the defaults', () => {
    const samples = [...run(0, 8, code), ...run(10, 18, terminal), ...run(20, 28, loginWindow)];
    const byString = sessionize(samples, { ignore: ['com.apple.Terminal'] });
    assert.deepEqual(
      byString.map((s) => s.appId),
      ['com.microsoft.VSCode', 'com.apple.loginwindow'],
    );
    const byRegExp = sessionize(samples, { ignore: [/^Code$/, /login/] });
    assert.deepEqual(
      byRegExp.map((s) => s.appId),
      ['com.apple.Terminal'],
    );
    const byFunction = sessionize(samples, { ignore: [(w) => w.title === 'index.ts'] });
    assert.deepEqual(
      byFunction.map((s) => s.appId),
      ['com.apple.Terminal', 'com.apple.loginwindow'],
    );
  });

  it('ignores nothing when given an empty list', () => {
    assert.equal(sessionize(run(0, 10, loginWindow), { ignore: [] }).length, 1);
  });

  it('behaves the same on every call with a global RegExp', () => {
    const options = { ignore: [/Terminal/g] };
    assert.deepEqual(sessionize(run(0, 10, terminal), options), []);
    assert.deepEqual(sessionize(run(0, 10, terminal), options), []);
  });
});

describe('hosts', () => {
  it('stores the host, not the URL, by default', () => {
    const segments = sessionize(run(0, 6, chrome('https://github.com/saimulft/repo?tab=readme#top')));
    assert.equal(segments[0]?.host, 'github.com');
    assert.ok(!JSON.stringify(segments).includes('saimulft'));
    assert.equal('url' in (segments[0] ?? {}), false);
  });

  it('has no host for a non-browser app, even if the window title looks like a URL', () => {
    const segments = sessionize(run(0, 6, { app: 'Code', appId: 'com.microsoft.VSCode', title: 'https://github.com' }));
    assert.equal(segments[0]?.host, undefined);
  });

  it('has no host for non-http URLs and malformed URLs, but still counts the app', () => {
    for (const url of ['file:///Users/me/a.html', 'about:blank', 'chrome://newtab', 'garbage', '']) {
      const segments = sessionize(run(0, 6, chrome(url)));
      assert.equal(segments.length, 1, url);
      assert.equal(segments[0]?.host, undefined, url);
    }
  });

  it('keeps the browser segment together when it moves between URLs without a host', () => {
    const samples = [...run(0, 4, chrome('about:blank')), ...run(6, 10, chrome('chrome://newtab'))];
    assert.deepEqual(brief(sessionize(samples)), [{ appId: 'com.google.Chrome', start: 0, end: 10 }]);
  });

  it('keeps pages of the same host in one segment', () => {
    const samples = [...run(0, 4, chrome('https://github.com/a')), ...run(6, 10, chrome('https://GITHUB.com/b'))];
    assert.deepEqual(brief(sessionize(samples)), [
      { appId: 'com.google.Chrome', host: 'github.com', start: 0, end: 10 },
    ]);
  });

  it("drops hosts with urls: 'none'", () => {
    const segments = sessionize(run(0, 6, chrome('https://github.com/a')), { urls: 'none' });
    assert.equal(segments[0]?.host, undefined);
  });

  it("stores the URL without its fragment with urls: 'full', and splits by page", () => {
    const samples = [...run(0, 4, chrome('https://github.com/a#x')), ...run(6, 10, chrome('https://github.com/b'))];
    const segments = sessionize(samples, { urls: 'full' });
    assert.deepEqual(
      segments.map((s) => [s.host, s.url]),
      [
        ['github.com', 'https://github.com/a'],
        ['github.com', 'https://github.com/b'],
      ],
    );
  });
});

describe('option validation', () => {
  it('rejects negative or non-numeric limits and unknown url modes', () => {
    assert.throws(() => sessionize([], { mergeGapMs: -1 }), RangeError);
    assert.throws(() => sessionize([], { minSegmentMs: Number.NaN }), RangeError);
    assert.throws(() => sessionize([], { urls: 'all' as never }), RangeError);
  });
});
