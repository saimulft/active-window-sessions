import type { IgnoreRule, WindowInfo } from './types.ts';

/**
 * macOS system UI that takes the front for a moment (alerts, the login window, the screen saver).
 * These are not apps the user chose to work in. Entries are matched against `appId` and `app`.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  'com.apple.UserNotificationCenter',
  'com.apple.notificationcenterui',
  'com.apple.loginwindow',
  'com.apple.screensaver.engine',
  'com.apple.ScreenSaver.Engine',
  'com.apple.SecurityAgent',
  'com.apple.coreservices.uiagent',
  'com.apple.controlcenter',
  'UserNotificationCenter',
  'loginwindow',
  'ScreenSaverEngine',
];

/** Builds one predicate from a list of ignore rules. */
export function compileIgnore(rules: readonly IgnoreRule[]): (window: WindowInfo) => boolean {
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  const predicates: Array<(window: WindowInfo) => boolean> = [];
  for (const rule of rules) {
    if (typeof rule === 'string') names.add(rule);
    else if (rule instanceof RegExp) patterns.push(rule);
    else predicates.push(rule);
  }
  return (window) => {
    const ids = [window.app, window.appId ?? ''];
    if (ids.some((id) => names.has(id))) return true;
    for (const pattern of patterns) {
      // Reset first so a global or sticky RegExp gives the same answer on every call.
      pattern.lastIndex = 0;
      if (ids.some((id) => id && pattern.test(id))) return true;
    }
    return predicates.some((predicate) => predicate(window));
  };
}
