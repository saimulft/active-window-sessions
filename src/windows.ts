import type { WindowInfo } from './types.ts';

/** A permission flag for get-windows on macOS: a fixed value, or a function read before every poll. */
export type PermissionFlag = boolean | (() => boolean);

/** Options for `getWindowsSampler`. */
export interface WindowsSamplerOptions {
  /**
   * Read the URL of browser tabs (macOS). When `false`, Accessibility is not requested from
   * get-windows, so it neither reads URLs nor triggers a browser Automation prompt. Default `true`.
   */
  urls?: boolean;
  /** Overrides get-windows' `accessibilityPermission` option (macOS). Wins over `urls`. */
  accessibilityPermission?: PermissionFlag;
  /** Overrides get-windows' `screenRecordingPermission` option (macOS). */
  screenRecordingPermission?: PermissionFlag;
  /** Platform to assume. Defaults to `process.platform`. get-windows options are only passed on `'darwin'`. */
  platform?: string;
  /** Loads the get-windows module. Defaults to a lazy `import('get-windows')`. Useful in tests. */
  loadModule?: () => Promise<unknown>;
}

interface GetWindowsOptions {
  accessibilityPermission?: boolean;
  screenRecordingPermission?: boolean;
}

type ActiveWindowFn = (options?: GetWindowsOptions) => Promise<unknown> | unknown;

const MISSING_MESSAGE =
  'active-window-sessions: the "get-windows" package could not be loaded. Install it with: npm install get-windows';

async function defaultLoad(): Promise<unknown> {
  // A variable specifier keeps get-windows out of type checking and bundler graphs: it is an optional peer.
  const specifier = 'get-windows';
  try {
    return (await import(specifier)) as unknown;
  } catch (cause) {
    throw new Error(MISSING_MESSAGE, { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveActiveWindow(mod: unknown): ActiveWindowFn | null {
  if (typeof mod === 'function') return mod as ActiveWindowFn;
  if (!isRecord(mod)) return null;
  if (typeof mod.activeWindow === 'function') return mod.activeWindow as ActiveWindowFn;
  if (typeof mod.default === 'function') return mod.default as ActiveWindowFn;
  if (isRecord(mod.default) && typeof mod.default.activeWindow === 'function') {
    return mod.default.activeWindow as ActiveWindowFn;
  }
  return null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Converts a get-windows (or active-win) result into a `WindowInfo`, or `null` when it has no
 * owning app. `appId` is the macOS bundle id, else the executable file name, else the app name.
 */
export function toWindowInfo(result: unknown): WindowInfo | null {
  if (!isRecord(result) || !isRecord(result.owner)) return null;
  const owner = result.owner;
  const name = text(owner.name);
  const appId = text(owner.bundleId) || fileName(text(owner.path)) || name;
  const app = name || appId;
  if (!app) return null;
  return {
    app,
    appId,
    title: typeof result.title === 'string' ? result.title : '',
    ...(typeof result.url === 'string' && result.url ? { url: result.url } : {}),
  };
}

const read = (flag: PermissionFlag): boolean => (typeof flag === 'function' ? flag() : flag);

/**
 * A `sample` function backed by get-windows, which is loaded on first use. Pass it to `createTracker`.
 * get-windows is an optional peer dependency; the sampler throws a clear error when it is missing.
 */
export function getWindowsSampler(options: WindowsSamplerOptions = {}): () => Promise<WindowInfo | null> {
  const load = options.loadModule ?? defaultLoad;
  const platform = options.platform ?? process.platform;
  let loading: Promise<ActiveWindowFn> | null = null;

  const getFunction = (): Promise<ActiveWindowFn> => {
    loading ??= load().then((mod) => {
      const fn = resolveActiveWindow(mod);
      if (!fn) throw new Error('active-window-sessions: get-windows does not export an activeWindow function');
      return fn;
    });
    // A failed load is not cached, so installing the package later works without a restart.
    loading.catch(() => {
      loading = null;
    });
    return loading;
  };

  const callOptions = (): GetWindowsOptions | undefined => {
    if (platform !== 'darwin') return undefined;
    const out: GetWindowsOptions = {};
    if (options.accessibilityPermission !== undefined)
      out.accessibilityPermission = read(options.accessibilityPermission);
    else if (options.urls === false) out.accessibilityPermission = false;
    if (options.screenRecordingPermission !== undefined) {
      out.screenRecordingPermission = read(options.screenRecordingPermission);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  return async () => toWindowInfo(await (await getFunction())(callOptions()));
}
