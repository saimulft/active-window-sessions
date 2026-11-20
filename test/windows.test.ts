import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTracker, getWindowsSampler, toWindowInfo } from '../src/index.ts';
import { FakeClock } from './helpers/fake-clock.ts';

// None of these tests loads get-windows or reads a real window: every module is a fake.

const macResult = {
  platform: 'macos',
  title: 'Pull requests',
  owner: {
    name: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    path: '/Applications/Google Chrome.app',
    processId: 1,
  },
  url: 'https://github.com/pulls',
};
const windowsResult = {
  platform: 'windows',
  title: 'notes.txt - Notepad',
  owner: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe', processId: 2 },
};
const linuxResult = {
  platform: 'linux',
  title: 'term',
  owner: { name: 'gnome-terminal-server', path: '/usr/libexec/gnome-terminal-server', processId: 3 },
};

describe('toWindowInfo', () => {
  it('uses the bundle id on macOS and keeps the URL', () => {
    assert.deepEqual(toWindowInfo(macResult), {
      app: 'Google Chrome',
      appId: 'com.google.Chrome',
      title: 'Pull requests',
      url: 'https://github.com/pulls',
    });
  });

  it('uses the executable file name on Windows and Linux', () => {
    assert.equal(toWindowInfo(windowsResult)?.appId, 'notepad.exe');
    assert.equal(toWindowInfo(linuxResult)?.appId, 'gnome-terminal-server');
  });

  it('falls back to the app name when there is no bundle id or path', () => {
    assert.deepEqual(toWindowInfo({ owner: { name: 'Mystery' } }), { app: 'Mystery', appId: 'Mystery', title: '' });
  });

  it('returns null for missing or ownerless results', () => {
    for (const value of [undefined, null, 'x', 42, {}, { owner: null }, { owner: {} }, { owner: { name: '  ' } }]) {
      assert.equal(toWindowInfo(value), null, JSON.stringify(value));
    }
  });

  it('omits an empty or non-string url', () => {
    assert.equal('url' in (toWindowInfo({ ...macResult, url: '' }) ?? {}), false);
    assert.equal('url' in (toWindowInfo({ ...macResult, url: 5 }) ?? {}), false);
  });
});

describe('getWindowsSampler', () => {
  it('loads the module lazily, once, and maps the result', async () => {
    let loads = 0;
    let calls = 0;
    const sample = getWindowsSampler({
      platform: 'linux',
      loadModule: async () => {
        loads += 1;
        return {
          activeWindow: async () => {
            calls += 1;
            return linuxResult;
          },
        };
      },
    });
    assert.equal(loads, 0);
    assert.equal((await sample())?.app, 'gnome-terminal-server');
    await sample();
    assert.equal(loads, 1);
    assert.equal(calls, 2);
  });

  it('returns null when get-windows finds no window', async () => {
    const sample = getWindowsSampler({ loadModule: async () => ({ activeWindow: async () => undefined }) });
    assert.equal(await sample(), null);
  });

  it('accepts the module shapes get-windows and active-win can have', async () => {
    const fn = async () => windowsResult;
    for (const mod of [fn, { activeWindow: fn }, { default: fn }, { default: { activeWindow: fn } }]) {
      const sample = getWindowsSampler({ loadModule: async () => mod });
      assert.equal((await sample())?.appId, 'notepad.exe');
    }
  });

  it('throws a clear error when the module has no activeWindow function', async () => {
    const sample = getWindowsSampler({ loadModule: async () => ({ openWindows: () => [] }) });
    await assert.rejects(sample(), /does not export an activeWindow function/);
  });

  it('passes nothing to get-windows by default, and nothing off macOS', async () => {
    const seen: unknown[] = [];
    const loadModule = async () => ({
      activeWindow: async (options?: unknown) => {
        seen.push(options);
        return macResult;
      },
    });
    await getWindowsSampler({ platform: 'darwin', loadModule })();
    await getWindowsSampler({ platform: 'win32', urls: false, accessibilityPermission: true, loadModule })();
    assert.deepEqual(seen, [undefined, undefined]);
  });

  it('turns Accessibility off on macOS when urls is false, so no URL is read and no Automation prompt appears', async () => {
    const seen: unknown[] = [];
    const sample = getWindowsSampler({
      platform: 'darwin',
      urls: false,
      loadModule: async () => ({
        activeWindow: async (options?: unknown) => {
          seen.push(options);
          return macResult;
        },
      }),
    });
    await sample();
    assert.deepEqual(seen, [{ accessibilityPermission: false }]);
  });

  it('reads permission flags before every call, so cached macOS states can be wired in', async () => {
    const seen: unknown[] = [];
    let accessibility = false;
    const sample = getWindowsSampler({
      platform: 'darwin',
      accessibilityPermission: () => accessibility,
      screenRecordingPermission: true,
      loadModule: async () => ({
        activeWindow: async (options?: unknown) => {
          seen.push(options);
          return macResult;
        },
      }),
    });
    await sample();
    accessibility = true;
    await sample();
    assert.deepEqual(seen, [
      { accessibilityPermission: false, screenRecordingPermission: true },
      { accessibilityPermission: true, screenRecordingPermission: true },
    ]);
  });

  it('retries loading after a failure instead of caching it', async () => {
    let attempts = 0;
    const sample = getWindowsSampler({
      loadModule: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Cannot find package');
        return { activeWindow: async () => windowsResult };
      },
    });
    await assert.rejects(sample(), /Cannot find package/);
    assert.equal((await sample())?.appId, 'notepad.exe');
  });

  it('plugs into a tracker', async () => {
    const clock = new FakeClock();
    const sample = getWindowsSampler({ loadModule: async () => ({ activeWindow: async () => macResult }) });
    const delivered: unknown[] = [];
    const tracker = createTracker({ clock, sample, onSegments: (s) => delivered.push(...s) });
    tracker.start();
    await clock.advance(6000);
    tracker.stop();
    assert.equal(delivered.length, 1);
    assert.equal((delivered[0] as { host: string }).host, 'github.com');
  });
});
