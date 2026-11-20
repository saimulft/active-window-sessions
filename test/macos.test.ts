import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMacPermissions, MAC_BROWSERS } from '../src/macos.ts';
import type { CommandResult, CommandRunner, MacPermissionsOptions, SystemPreferencesLike } from '../src/macos.ts';

// Nothing here runs osascript or touches Electron: the runner and systemPreferences are fakes.

const CHROME = 'com.google.Chrome';
const SAFARI = 'com.apple.Safari';
const NOT_AUTHORIZED = 'execution error: Not authorized to send Apple events to Google Chrome. (-1743)';

function fakePrefs(initial: { trusted?: boolean; screen?: string } = {}) {
  const state = { trusted: initial.trusted ?? true, screen: initial.screen ?? 'granted', prompts: 0, throws: false };
  const prefs: SystemPreferencesLike = {
    isTrustedAccessibilityClient(prompt) {
      if (state.throws) throw new Error('unavailable');
      if (prompt) state.prompts += 1;
      return state.trusted;
    },
    getMediaAccessStatus() {
      if (state.throws) throw new Error('unavailable');
      return state.screen;
    },
  };
  return { prefs, state };
}

/** A runner that answers per bundle id from a table and records every call. */
function fakeRunner(answers: Record<string, CommandResult | Error>) {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const runner: CommandRunner = async (command, args, { timeoutMs }) => {
    calls.push({ command, args, timeoutMs });
    const script = args[1] ?? '';
    const bundleId = Object.keys(answers).find((id) => script.includes(`"${id}"`));
    const answer = bundleId ? answers[bundleId] : undefined;
    if (!answer) throw new Error(`no canned answer for ${script}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runner, calls };
}

const ok = (stdout: string): CommandResult => ({ stdout: `${stdout}\n`, stderr: '', exitCode: 0 });
const denied: CommandResult = { stdout: '', stderr: NOT_AUTHORIZED, exitCode: 1 };

function setup(overrides: Partial<MacPermissionsOptions> = {}, prefsInit: Parameters<typeof fakePrefs>[0] = {}) {
  const { prefs, state } = fakePrefs(prefsInit);
  const clock = { t: 1_000_000 };
  const forbidden: CommandRunner = async () => {
    throw new Error('the command runner must not be called here');
  };
  const permissions = createMacPermissions({
    systemPreferences: prefs,
    platform: 'darwin',
    now: () => clock.t,
    runCommand: forbidden,
    browsers: MAC_BROWSERS.filter((b) => b.bundleId === CHROME || b.bundleId === SAFARI),
    ...overrides,
  });
  return { permissions, state, clock };
}

describe('accessibility and screen recording', () => {
  it('reports granted and denied Accessibility', () => {
    assert.equal(setup({}, { trusted: true }).permissions.accessibilityState(), 'granted');
    assert.equal(setup({}, { trusted: false }).permissions.accessibilityState(), 'denied');
  });

  it('never prompts when only reading the state', () => {
    const { permissions, state } = setup({}, { trusted: false });
    permissions.accessibilityState();
    assert.equal(state.prompts, 0);
  });

  it('maps Screen Recording states, including not-determined', () => {
    const states: Array<[string, string]> = [
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['not-determined', 'not_determined'],
      ['restricted', 'restricted'],
      ['something-new', 'unknown'],
    ];
    for (const [electron, expected] of states) {
      assert.equal(setup({}, { screen: electron }).permissions.screenState(), expected, electron);
    }
  });

  it('reports unknown when Electron throws', () => {
    const { prefs, state } = fakePrefs();
    state.throws = true;
    const permissions = createMacPermissions({
      systemPreferences: prefs,
      platform: 'darwin',
      runCommand: async () => ok(''),
    });
    assert.equal(permissions.accessibilityState(), 'unknown');
    assert.equal(permissions.screenState(), 'unknown');
  });

  it('is granted and unsupported off macOS, and touches nothing', async () => {
    const { prefs } = fakePrefs({ trusted: false, screen: 'denied' });
    const permissions = createMacPermissions({
      systemPreferences: prefs,
      platform: 'linux',
      runCommand: async () => ok(''),
    });
    assert.equal(permissions.accessibilityState(), 'granted');
    assert.equal(permissions.screenState(), 'granted');
    assert.equal(await permissions.getPermissions(), null);
    assert.deepEqual(await permissions.getView(), { supported: false });
    assert.deepEqual(await permissions.request('accessibility'), { supported: false });
    assert.equal(permissions.openSettings('screen'), false);
  });
});

describe('automation probes', () => {
  it('reports granted when the browser answers the Apple Event', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted'), [SAFARI]: ok('granted') });
    const { permissions } = setup({ runCommand: runner });
    const snapshot = await permissions.getPermissions();
    assert.deepEqual(snapshot?.automation, { [CHROME]: 'granted', [SAFARI]: 'granted' });
    assert.equal(calls.length, 2);
  });

  it('runs osascript with a timeout and a script that never launches the browser', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted') });
    const { permissions } = setup({
      runCommand: runner,
      browsers: MAC_BROWSERS.filter((b) => b.bundleId === CHROME),
      probeTimeoutMs: 1234,
    });
    await permissions.getPermissions();
    assert.equal(calls[0]?.command, 'osascript');
    assert.equal(calls[0]?.args[0], '-e');
    assert.equal(calls[0]?.timeoutMs, 1234);
    assert.match(calls[0]?.args[1] ?? '', /is running/);
    assert.match(calls[0]?.args[1] ?? '', /count windows/);
  });

  it('reports denied for error -1743, in stderr or in a thrown error', async () => {
    const { runner } = fakeRunner({ [CHROME]: denied, [SAFARI]: new Error(`Command failed ${NOT_AUTHORIZED}`) });
    const snapshot = await setup({ runCommand: runner }).permissions.getPermissions();
    assert.deepEqual(snapshot?.automation, { [CHROME]: 'denied', [SAFARI]: 'denied' });
  });

  it('reports unknown for other failures, such as a timeout', async () => {
    const { runner } = fakeRunner({
      [CHROME]: { stdout: '', stderr: 'some other error', exitCode: 1 },
      [SAFARI]: new Error('timed out'),
    });
    const snapshot = await setup({ runCommand: runner }).permissions.getPermissions();
    assert.deepEqual(snapshot?.automation, { [CHROME]: 'unknown', [SAFARI]: 'unknown' });
  });

  it('reports a closed browser as unknown until a real answer is known, then keeps the last real answer', async () => {
    const answers: Record<string, CommandResult> = { [CHROME]: ok('not_running'), [SAFARI]: ok('not_running') };
    const { runner } = fakeRunner(answers);
    const { permissions, clock } = setup({ runCommand: runner });
    assert.equal((await permissions.getPermissions())?.automation[CHROME], 'not_running');

    answers[CHROME] = denied;
    clock.t += 20_000;
    assert.equal((await permissions.getPermissions())?.automation[CHROME], 'denied');

    answers[CHROME] = ok('not_running');
    clock.t += 20_000;
    assert.equal((await permissions.getPermissions())?.automation[CHROME], 'denied');
  });

  it('keeps the last real answer when a later probe times out', async () => {
    const answers: Record<string, CommandResult | Error> = { [CHROME]: ok('granted'), [SAFARI]: ok('granted') };
    const { runner } = fakeRunner(answers);
    const { permissions, clock } = setup({ runCommand: runner });
    await permissions.getPermissions();
    answers[CHROME] = new Error('timed out');
    clock.t += 20_000;
    assert.equal((await permissions.getPermissions())?.automation[CHROME], 'granted');
  });

  it('rejects bundle ids that are not safe to put in a script', async () => {
    const { runner, calls } = fakeRunner({});
    const evil = { name: 'Evil', bundleId: 'x" & do shell script "id', appFile: 'Evil.app' };
    const { permissions } = setup({ runCommand: runner, browsers: [evil] });
    const snapshot = await permissions.getPermissions();
    assert.equal(snapshot?.automation[evil.bundleId], 'unknown');
    assert.equal(calls.length, 0);
  });
});

describe('probe caching', () => {
  it('reuses an answer for automationCacheMs', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted'), [SAFARI]: ok('granted') });
    const { permissions, clock } = setup({ runCommand: runner });
    await permissions.getPermissions();
    clock.t += 9_999;
    await permissions.getPermissions();
    assert.equal(calls.length, 2);
    clock.t += 2;
    await permissions.getPermissions();
    assert.equal(calls.length, 4);
  });

  it('honours a custom automationCacheMs', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted') });
    const { permissions, clock } = setup({
      runCommand: runner,
      automationCacheMs: 100,
      browsers: MAC_BROWSERS.filter((b) => b.bundleId === CHROME),
    });
    await permissions.getPermissions();
    clock.t += 99;
    await permissions.getPermissions();
    assert.equal(calls.length, 1);
    clock.t += 2;
    await permissions.getPermissions();
    assert.equal(calls.length, 2);
  });

  it('probes again with fresh: true', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted'), [SAFARI]: ok('granted') });
    const { permissions } = setup({ runCommand: runner });
    await permissions.getPermissions();
    await permissions.getPermissions({ fresh: true });
    assert.equal(calls.length, 4);
  });

  it('shares one probe between concurrent calls', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted'), [SAFARI]: ok('granted') });
    const { permissions } = setup({ runCommand: runner });
    await Promise.all([permissions.getPermissions(), permissions.getPermissions(), permissions.getPermissions()]);
    assert.equal(calls.length, 2);
  });

  it('with probe: false uses cached answers only and never runs a command', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: ok('granted'), [SAFARI]: denied });
    const { permissions } = setup({ runCommand: runner });
    const before = await permissions.getPermissions({ probe: false });
    assert.deepEqual(before?.automation, { [CHROME]: 'unknown', [SAFARI]: 'unknown' });
    assert.equal(calls.length, 0);
    await permissions.getPermissions();
    const after = await permissions.getPermissions({ probe: false });
    assert.deepEqual(after?.automation, { [CHROME]: 'granted', [SAFARI]: 'denied' });
    assert.equal(calls.length, 2);
  });
});

describe('browser list', () => {
  it('lists the browsers that isInstalled accepts', async () => {
    const { permissions } = setup({ browsers: undefined, isInstalled: (b) => b.name === 'Arc' || b.name === 'Brave' });
    const view = await permissions.getView({ probe: false });
    assert.equal(view.supported, true);
    if (view.supported) {
      assert.deepEqual(view.browsers, [
        { name: 'Brave', bundleId: 'com.brave.Browser' },
        { name: 'Arc', bundleId: 'company.thebrowser.Browser' },
      ]);
    }
  });
});

describe('relaunch-needed', () => {
  it('is false when Screen Recording was granted at launch', async () => {
    const view = await setup({}, { screen: 'granted' }).permissions.getView({ probe: false });
    assert.equal(view.supported && view.needsRelaunch, false);
  });

  it('becomes true when Screen Recording is granted after launch', async () => {
    const { permissions, state } = setup({}, { screen: 'denied' });
    let view = await permissions.getView({ probe: false });
    assert.equal(view.supported && view.needsRelaunch, false);
    state.screen = 'granted';
    view = await permissions.getView({ probe: false });
    assert.equal(view.supported && view.needsRelaunch, true);
  });

  it('becomes true once Screen Recording was requested without a grant at launch', async () => {
    const { permissions } = setup({ requestScreenRecording: async () => {} }, { screen: 'not-determined' });
    await permissions.request('screen');
    const view = await permissions.getView({ probe: false });
    assert.equal(view.supported && view.needsRelaunch, true);
  });

  it('becomes true after opening the Screen Recording settings pane', async () => {
    const { permissions } = setup({ openExternal: () => {} }, { screen: 'denied' });
    permissions.openSettings('screen');
    const view = await permissions.getView({ probe: false });
    assert.equal(view.supported && view.needsRelaunch, true);
  });

  it('stays false after a request when Screen Recording was already granted at launch', async () => {
    const { permissions } = setup({ requestScreenRecording: async () => {} }, { screen: 'granted' });
    const view = await permissions.request('screen');
    assert.equal(view.supported && view.needsRelaunch, false);
  });

  it('calls the injected relaunch', () => {
    let relaunched = 0;
    setup({ relaunch: () => void (relaunched += 1) }).permissions.relaunch();
    assert.equal(relaunched, 1);
    setup().permissions.relaunch(); // no relaunch injected: does nothing
  });
});

describe('request and openSettings', () => {
  it('asks for Accessibility with a prompt', async () => {
    const { permissions, state } = setup({}, { trusted: false });
    const view = await permissions.request('accessibility');
    assert.equal(state.prompts, 1);
    assert.equal(view.supported && view.permissions.accessibility, 'denied');
  });

  it('triggers the injected Screen Recording prompt and reports its errors', async () => {
    const errors: unknown[] = [];
    let called = 0;
    const { permissions } = setup({
      requestScreenRecording: () => {
        called += 1;
        throw new Error('capture failed');
      },
      onError: (e) => errors.push(e),
    });
    await permissions.request('screen');
    assert.equal(called, 1);
    assert.equal(errors.length, 1);
  });

  it('probes one browser fresh for automation and returns the view without probing the others', async () => {
    const { runner, calls } = fakeRunner({ [CHROME]: denied, [SAFARI]: ok('granted') });
    const { permissions } = setup({ runCommand: runner });
    const view = await permissions.request('automation', CHROME);
    assert.equal(calls.length, 1);
    assert.equal(view.supported && view.permissions.automation[CHROME], 'denied');
    assert.equal(view.supported && view.permissions.automation[SAFARI], 'unknown');
  });

  it('ignores an automation request for a browser that is not in the list', async () => {
    const { runner, calls } = fakeRunner({});
    const { permissions } = setup({ runCommand: runner });
    await permissions.request('automation', 'com.example.NotABrowser');
    await permissions.request('automation');
    assert.equal(calls.length, 0);
  });

  it('opens the System Settings pane for each permission', () => {
    const opened: string[] = [];
    const { permissions } = setup({ openExternal: (url) => void opened.push(url) });
    assert.equal(permissions.openSettings('accessibility'), true);
    assert.equal(permissions.openSettings('screen'), true);
    assert.equal(permissions.openSettings('automation'), true);
    assert.deepEqual(
      opened.map((u) => u.split('?')[1]),
      ['Privacy_Accessibility', 'Privacy_ScreenCapture', 'Privacy_Automation'],
    );
  });

  it('returns false when no openExternal is injected or it throws', () => {
    assert.equal(setup().permissions.openSettings('screen'), false);
    const { permissions } = setup({
      openExternal: () => {
        throw new Error('no shell');
      },
    });
    assert.equal(permissions.openSettings('screen'), false);
  });

  it('returns the full view shape', async () => {
    const { runner } = fakeRunner({ [CHROME]: ok('granted'), [SAFARI]: ok('not_running') });
    const view = await setup({ runCommand: runner }).permissions.getView();
    assert.equal(view.supported, true);
    if (view.supported) {
      assert.deepEqual(Object.keys(view.permissions).sort(), ['accessibility', 'automation', 'screen']);
      assert.deepEqual(
        view.browsers.map((b) => b.name),
        ['Safari', 'Google Chrome'],
      );
    }
  });
});
