const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };
const OTHER_SITE = new Set(['cross-site', 'same-site']);

/** What the origin check reads: a web `Request` has it, and an adapter can pass less. */
export interface OriginCheckRequest {
  readonly headers: { get(name: string): string | null };
  readonly url: string;
}

/**
 * Builds the check that adapters run before `authenticate`. A request with no `Origin`
 * header passes, because it comes from a client that is not a browser: a browser sends
 * `Origin` on a WebSocket handshake, and on an SSE stream request too, because the stream's
 * `LiveThing-Protocol` header makes a cross-origin page send a preflight. A browser leaves
 * `Origin` out of a plain cross-site GET (an `<img>`, a `no-cors` fetch), but marks it with
 * `Sec-Fetch-Site`, so a request with no `Origin` from another site is refused. Otherwise the
 * Origin's host and port must match the request's `Host` header, or the Origin must be in
 * `allowedOrigins`.
 * The scheme is not compared, because behind a TLS proxy it cannot be trusted, and
 * `X-Forwarded-Host` is ignored, because any client can send it. A request with no
 * `Host` header (a Cloudflare Worker that built a new request) uses its URL's host.
 */
export function createOriginCheck(
  allowedOrigins: readonly string[] = [],
): (request: OriginCheckRequest) => boolean {
  const allowed = new Set(allowedOrigins.map(parseAllowedOrigin));

  return (request) => {
    const header = request.headers.get('origin');
    if (header === null) return !OTHER_SITE.has(request.headers.get('sec-fetch-site') ?? '');

    const origin = parseUrl(header);
    if (!origin || origin.origin === 'null') return false;

    if (allowed.has(origin.origin)) return true;

    const host = parseUrl(`http://${request.headers.get('host') ?? new URL(request.url).host}`);
    if (!host || host.hostname !== origin.hostname) return false;

    const originPort = origin.port || DEFAULT_PORTS[origin.protocol];
    // `http://` parsing drops port 80, so an explicit `:80` reads as no port.
    return host.port === '' ? originPort === '80' || origin.port === '' : host.port === originPort;
  };
}

// `URL.parse` needs Node 22.1, and the Node adapter supports Node 22.0.
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseAllowedOrigin(entry: string): string {
  const url = parseUrl(entry);
  if (!url || url.origin === 'null' || url.origin !== entry.replace(/\/$/, '')) {
    throw new TypeError(
      `[livething] allowedOrigins entry '${entry}' is not an origin. Write the scheme, host and port only, such as 'http://localhost:5173'.`,
    );
  }

  return url.origin;
}
