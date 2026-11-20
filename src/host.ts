/** A parsed http(s) URL. */
export interface ParsedUrl {
  /** Lower-case host name, without port or credentials. */
  host: string;
  /** The URL without its fragment. */
  href: string;
}

/** Parses an http(s) URL. Returns `null` for anything else, including malformed input. */
export function parseHttpUrl(url: string | null | undefined): ParsedUrl | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    if (!host) return null;
    parsed.hash = '';
    return { host, href: parsed.href };
  } catch {
    return null;
  }
}

/** Returns the lower-case host of an http(s) URL and drops the rest. Returns `null` for other schemes or malformed input. */
export function hostFromUrl(url: string | null | undefined): string | null {
  return parseHttpUrl(url)?.host ?? null;
}
