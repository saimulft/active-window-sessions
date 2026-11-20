import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Whether active-window reading is expected to work on this machine. */
export interface PlatformSupport {
  supported: boolean;
  /** Why it is not supported. */
  reason?: string;
}

/** Options for `checkPlatformSupport` and `defaultIdleThresholdSeconds`. All default to the current process. */
export interface PlatformOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  /** Tells whether a command exists on PATH. Defaults to a lookup that does not run anything. */
  commandExists?: (name: string) => boolean;
}

function onPath(name: string, env: Record<string, string | undefined>): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

/**
 * Checks the one known unsupported setup: Linux without X11 (Wayland has no active-window API, and
 * get-windows needs `xprop` and `xwininfo`). macOS and Windows are reported as supported.
 */
export function checkPlatformSupport(options: PlatformOptions = {}): PlatformSupport {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return { supported: true };
  const env = options.env ?? process.env;
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || (Boolean(env.WAYLAND_DISPLAY) && !env.DISPLAY);
  if (wayland) return { supported: false, reason: 'Wayland sessions have no active-window API; use an X11 session.' };
  const exists = options.commandExists ?? ((name: string) => onPath(name, env));
  const missing = ['xprop', 'xwininfo'].filter((name) => !exists(name));
  if (missing.length > 0) return { supported: false, reason: `Missing X11 tools: ${missing.join(', ')}.` };
  return { supported: true };
}

/** Whether this looks like a remote desktop (RDP) or SSH session. */
export function isRemoteSession(options: PlatformOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === 'win32') {
    const name = env.SESSIONNAME ?? '';
    return name.startsWith('RDP') || name.includes('Remote');
  }
  if (platform === 'darwin' || platform === 'linux') return env.SSH_CONNECTION != null || env.SSH_CLIENT != null;
  return false;
}

/**
 * A reasonable `idleAfterSeconds`: 50 on a local session, 30 on a remote one, where the system
 * idle counter is less reliable.
 */
export function defaultIdleThresholdSeconds(options: PlatformOptions = {}): number {
  return isRemoteSession(options) ? 30 : 50;
}
