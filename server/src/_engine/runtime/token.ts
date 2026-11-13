import { decodeBase64Url, TOKEN_SUBPROTOCOL_PREFIX } from '@livething/core';

/**
 * A browser `WebSocket` cannot set `Authorization`, so the client sends its token as a
 * `Sec-WebSocket-Protocol` entry. This moves it to `Authorization: Bearer <token>` and
 * removes the entry, so `authenticate` reads the token the same way on every transport.
 * A real `Authorization` header wins, and the entry is still removed. Returns the request
 * unchanged when it has no token entry, and `null` when the entry does not decode.
 */
export function moveTokenToAuthorization(request: Request): Request | null {
  const offered = request.headers.get('sec-websocket-protocol');
  if (!offered?.includes(TOKEN_SUBPROTOCOL_PREFIX)) return request;

  const names = offered.split(',').map((name) => name.trim());
  const entry = names.find((name) => name.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
  if (!entry) return request;

  const token = decodeBase64Url(entry.slice(TOKEN_SUBPROTOCOL_PREFIX.length));
  if (!token) return null;

  const headers = new Headers(request.headers);
  const rest = names.filter((name) => !name.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
  if (rest.length > 0) {
    headers.set('sec-websocket-protocol', rest.join(', '));
  } else {
    headers.delete('sec-websocket-protocol');
  }

  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);

  return new Request(request, { headers });
}
