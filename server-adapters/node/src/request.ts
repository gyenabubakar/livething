import type { IncomingMessage } from 'node:http';

/** Optional request metadata supplied while adapting a Node upgrade. */
export interface WebRequestOptions {
  signal?: AbortSignal;
  clientIp?: string;
}

/** Converts Node's incoming upgrade request into the standard Web API shape. */
export function requestToWebRequest(
  request: IncomingMessage,
  options: WebRequestOptions = {},
): Request {
  const { signal, clientIp } = options;
  const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
  const protocol = encrypted ? 'https' : 'http';
  const host = request.headers.host ?? 'localhost';
  const target = request.url ?? '/';
  const base = new URL(`${protocol}://${host}`);

  // WHATWG URL parsing treats backslashes as authority separators in special URLs.
  if (target.includes('\\')) {
    throw new TypeError('[wskit] request target contains a backslash');
  }

  const url = new URL(target.startsWith('//') ? `${base.origin}${target}` : target, base);
  if (url.origin !== base.origin) {
    throw new TypeError('[wskit] request target authority does not match Host');
  }
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  headers.delete('WSKit-Client-IP');
  if (clientIp !== undefined) headers.set('WSKit-Client-IP', clientIp);

  return new Request(url, {
    method: request.method ?? 'GET',
    headers,
    body: null,
    signal,
  });
}
