import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A browser whose tabs can be read through macOS Automation (Apple Events). */
export interface MacBrowser {
  name: string;
  bundleId: string;
  /** App bundle file name, such as `Safari.app`. */
  appFile: string;
}

/** Browsers that are probed for Automation permission by default. */
export const MAC_BROWSERS: readonly MacBrowser[] = [
  { name: 'Safari', bundleId: 'com.apple.Safari', appFile: 'Safari.app' },
  { name: 'Google Chrome', bundleId: 'com.google.Chrome', appFile: 'Google Chrome.app' },
  { name: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', appFile: 'Microsoft Edge.app' },
  { name: 'Brave', bundleId: 'com.brave.Browser', appFile: 'Brave Browser.app' },
  { name: 'Arc', bundleId: 'company.thebrowser.Browser', appFile: 'Arc.app' },
  { name: 'Opera', bundleId: 'com.operasoftware.Opera', appFile: 'Opera.app' },
  { name: 'Vivaldi', bundleId: 'com.vivaldi.Vivaldi', appFile: 'Vivaldi.app' },
];

/** Which macOS permission. */
export type PermissionKind = 'accessibility' | 'screen' | 'automation';

/** Accessibility is either trusted or not; `unknown` when Electron could not tell. */
export type AccessibilityState = 'granted' | 'denied' | 'unknown';

/**
 * Screen Recording. Electron reports `denied` both before the first prompt and after a refusal,
 * so `not_determined` is only seen when macOS says so.
 */
export type ScreenState = 'granted' | 'denied' | 'not_determined' | 'restricted' | 'unknown';

/** Automation for one browser. `not_running` is returned by a probe only; snapshots fall back to the last real answer. */
export type AutomationState = 'granted' | 'denied' | 'not_running' | 'unknown';

/** The parts of Electron's `systemPreferences` that are used. Pass the real one in your app. */
export interface SystemPreferencesLike {
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  getMediaAccessStatus(mediaType: 'screen'): string;
}

/** Output of a finished command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a command and resolves with its output, even for a non-zero exit code. Reject only when the
 * command could not run or timed out.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CommandResult>;

/** Runs commands with `child_process.execFile`. This is the default runner; it really runs the command. */
export const execFileRunner: CommandRunner = (command, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (typeof failure.code === 'number' && !failure.killed) {
        return resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: failure.code });
      }
      reject(error);
    });
  });

/** Options for `createMacPermissions`. */
export interface MacPermissionsOptions {
  /** Electron's `systemPreferences`. */
  systemPreferences: SystemPreferencesLike;
  /** Runs `osascript` for Automation probes. Defaults to `execFileRunner`. */
  runCommand?: CommandRunner;
  /** Platform to assume. Defaults to `process.platform`; everything is a no-op unless it is `'darwin'`. */
  platform?: string;
  /** Time source in milliseconds, for the probe cache. Defaults to `Date.now`. */
  now?: () => number;
  /** Browsers to probe. When omitted, the entries of `MAC_BROWSERS` that `isInstalled` accepts. */
  browsers?: readonly MacBrowser[];
  /** Tells whether a browser is installed. Defaults to a check of `/Applications` and `~/Applications`; Safari always counts. */
  isInstalled?: (browser: MacBrowser) => boolean;
  /** How long an Automation answer is reused, so a 2 s re-check does not repeat the prompt. Default 10000. */
  automationCacheMs?: number;
  /** How long an Automation probe may take. Default 2000. */
  probeTimeoutMs?: number;
  /** Triggers the Screen Recording prompt, for example `() => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })`. */
  requestScreenRecording?: () => unknown;
  /** Opens a System Settings URL, for example `shell.openExternal`. */
  openExternal?: (url: string) => unknown;
  /** Restarts the app, for example `() => { app.relaunch(); app.quit(); }`. */
  relaunch?: () => void;
  /** Receives errors from the injected callbacks. Without it they are ignored. */
  onError?: (error: unknown) => void;
}

/** Permission states at one moment. */
export interface PermissionsSnapshot {
  accessibility: AccessibilityState;
  screen: ScreenState;
  /** Automation state by browser bundle id. */
  automation: Record<string, AutomationState>;
}

/** Options for `getPermissions` and `getView`. */
export interface PermissionsReadOptions {
  /** Run Automation probes. When `false`, only answers from earlier probes are used. Default `true`. */
  probe?: boolean;
  /** Ignore cached probe answers and probe again. Default `false`. */
  fresh?: boolean;
}

/** What a permissions screen needs. `supported` is `false` off macOS. */
export type PermissionsView =
  | { supported: false }
  | {
      supported: true;
      permissions: PermissionsSnapshot;
      browsers: Array<{ name: string; bundleId: string }>;
      /** A Screen Recording grant only applies after the app restarts. */
      needsRelaunch: boolean;
    };

/** The macOS permission helpers. */
export interface MacPermissions {
  /** Accessibility state. `granted` on other platforms, where no permission is needed. */
  accessibilityState(): AccessibilityState;
  /** Screen Recording state. `granted` on other platforms. */
  screenState(): ScreenState;
  /** All permission states, or `null` off macOS. */
  getPermissions(options?: PermissionsReadOptions): Promise<PermissionsSnapshot | null>;
  /** Permission states plus browser names and whether a relaunch is due. */
  getView(options?: PermissionsReadOptions): Promise<PermissionsView>;
  /** Shows the macOS prompt where one exists, then returns the view (without probing). A refusal needs System Settings. */
  request(kind: PermissionKind, bundleId?: string): Promise<PermissionsView>;
  /** Opens the System Settings pane for a permission. Returns `false` when it could not. */
  openSettings(kind: PermissionKind): boolean;
  /** Calls the injected `relaunch`. */
  relaunch(): void;
}

const SETTINGS_PANES: Record<PermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

function defaultIsInstalled(browser: MacBrowser): boolean {
  if (browser.bundleId === 'com.apple.Safari') return true;
  return ['/Applications', join(homedir(), 'Applications')].some((dir) => existsSync(join(dir, browser.appFile)));
}

/**
 * Creates the macOS permission helpers: Accessibility, Screen Recording, and Automation per browser.
 * Create it once the app is ready: the Screen Recording state at that moment decides whether a
 * later grant needs a relaunch. Nothing here runs a command unless `getPermissions`, `getView` or
 * `request` is asked to probe Automation.
 */
export function createMacPermissions(options: MacPermissionsOptions): MacPermissions {
  const { systemPreferences } = options;
  const isMac = (options.platform ?? process.platform) === 'darwin';
  const run = options.runCommand ?? execFileRunner;
  const now = options.now ?? Date.now;
  const cacheMs = options.automationCacheMs ?? 10_000;
  const timeoutMs = options.probeTimeoutMs ?? 2000;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // An error handler that throws must not break the helpers.
    }
  };

  let installed: readonly MacBrowser[] | null = null;
  const listBrowsers = (): readonly MacBrowser[] => {
    if (installed) return installed;
    const isInstalled = options.isInstalled ?? defaultIsInstalled;
    installed = options.browsers ?? MAC_BROWSERS.filter((browser) => isInstalled(browser));
    return installed;
  };

  /** Last probe per browser. */
  const probes = new Map<string, { state: AutomationState; at: number }>();
  /** Last real (granted or denied) answer, kept while the browser is closed. */
  const known = new Map<string, 'granted' | 'denied'>();
  const inFlight = new Map<string, Promise<AutomationState>>();
  let screenRequested = false;

  const accessibilityState = (): AccessibilityState => {
    if (!isMac) return 'granted';
    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
    } catch {
      return 'unknown';
    }
  };

  const screenState = (): ScreenState => {
    if (!isMac) return 'granted';
    try {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'not-determined') return 'not_determined';
      if (status === 'granted' || status === 'denied' || status === 'restricted') return status;
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const screenAtLaunch = screenState();

  async function runProbe(bundleId: string): Promise<AutomationState> {
    // `is running` never launches the browser; `count windows` is the Apple Event that needs consent.
    const script = [
      `if application id "${bundleId}" is running then`,
      `tell application id "${bundleId}" to count windows`,
      'return "granted"',
      'end if',
      'return "not_running"',
    ].join('\n');
    try {
      const result = await run('osascript', ['-e', script], { timeoutMs });
      if (result.exitCode === 0) return result.stdout.trim() === 'not_running' ? 'not_running' : 'granted';
      return /-1743\b/.test(result.stderr) ? 'denied' : 'unknown';
    } catch (error) {
      return /-1743\b/.test(error instanceof Error ? error.message : String(error)) ? 'denied' : 'unknown';
    }
  }

  function automationState(bundleId: string, fresh: boolean): Promise<AutomationState> {
    const cached = probes.get(bundleId);
    if (!fresh && cached && now() - cached.at < cacheMs) return Promise.resolve(cached.state);
    const pending = inFlight.get(bundleId);
    if (pending) return pending;
    const probe = runProbe(bundleId)
      .then((state) => {
        probes.set(bundleId, { state, at: now() });
        if (state === 'granted' || state === 'denied') known.set(bundleId, state);
        return state;
      })
      .finally(() => inFlight.delete(bundleId));
    inFlight.set(bundleId, probe);
    return probe;
  }

  async function getPermissions({ probe = true, fresh = false }: PermissionsReadOptions = {}) {
    if (!isMac) return null;
    const automation: Record<string, AutomationState> = {};
    await Promise.all(
      listBrowsers().map(async ({ bundleId }) => {
        if (!BUNDLE_ID.test(bundleId)) {
          automation[bundleId] = 'unknown';
          return;
        }
        if (!probe) {
          automation[bundleId] = known.get(bundleId) ?? 'unknown';
          return;
        }
        const state = await automationState(bundleId, fresh);
        // A closed browser or a probe that timed out keeps the last real answer.
        automation[bundleId] = state === 'not_running' || state === 'unknown' ? (known.get(bundleId) ?? state) : state;
      }),
    );
    return { accessibility: accessibilityState(), screen: screenState(), automation };
  }

  async function getView(readOptions?: PermissionsReadOptions): Promise<PermissionsView> {
    const permissions = await getPermissions(readOptions);
    if (!permissions) return { supported: false };
    const needsRelaunch =
      (permissions.screen === 'granted' && screenAtLaunch !== 'granted') ||
      (screenRequested && screenAtLaunch !== 'granted');
    return {
      supported: true,
      permissions,
      browsers: listBrowsers().map(({ name, bundleId }) => ({ name, bundleId })),
      needsRelaunch,
    };
  }

  async function request(kind: PermissionKind, bundleId?: string): Promise<PermissionsView> {
    if (!isMac) return { supported: false };
    if (kind === 'accessibility') {
      try {
        systemPreferences.isTrustedAccessibilityClient(true);
      } catch (error) {
        report(error);
      }
    } else if (kind === 'screen') {
      screenRequested = true;
      try {
        await options.requestScreenRecording?.();
      } catch (error) {
        report(error);
      }
    } else if (kind === 'automation' && bundleId && listBrowsers().some((b) => b.bundleId === bundleId)) {
      if (BUNDLE_ID.test(bundleId)) await automationState(bundleId, true);
    }
    return getView({ probe: false });
  }

  function openSettings(kind: PermissionKind): boolean {
    const url = isMac ? SETTINGS_PANES[kind] : undefined;
    if (!url || !options.openExternal) return false;
    if (kind === 'screen') screenRequested = true;
    try {
      Promise.resolve(options.openExternal(url)).catch(report);
    } catch (error) {
      report(error);
      return false;
    }
    return true;
  }

  return {
    accessibilityState,
    screenState,
    getPermissions,
    getView,
    request,
    openSettings,
    relaunch: () => options.relaunch?.(),
  };
}
