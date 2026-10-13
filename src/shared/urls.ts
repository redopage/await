// Destinations Await will call: public HTTPS on the default port, with no credentials,
// fragment, raw IP address or local-only host. Returns the normalized URL or null.
export function publicHttpsUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return null;
    if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
    return url.toString();
  } catch { return null; }
}
