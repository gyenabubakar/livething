import { decodeBase64, encodeBase64 } from './base64.ts';

/** The plain subprotocol name. A client offers it only together with a token. */
export const LIVETHING_SUBPROTOCOL = 'livething-v1';

/** The token subprotocol is this prefix followed by the base64url-encoded token. */
export const TOKEN_SUBPROTOCOL_PREFIX = `${LIVETHING_SUBPROTOCOL}.token.`;

/** Encodes text as UTF-8, then as base64url with no padding. */
export function encodeBase64Url(text: string): string {
  return encodeBase64(new TextEncoder().encode(text), true);
}

/** Decodes unpadded base64url to UTF-8 text, or `null` when it is not valid. */
export function decodeBase64Url(encoded: string): string | null {
  const bytes = /[+/=]/.test(encoded) ? null : decodeBase64(encoded);
  if (!bytes) return null;

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The subprotocols a client offers: the app's own names, or `livething-v1` when it has none,
 * then the token name last. Without a token, only the app's own names.
 */
export function tokenSubprotocols(
  token: string | null | undefined,
  protocols: readonly string[] | undefined,
): string[] | undefined {
  if (!token) return protocols ? [...protocols] : undefined;

  const names = protocols?.length ? [...protocols] : [LIVETHING_SUBPROTOCOL];
  return [...names, TOKEN_SUBPROTOCOL_PREFIX + encodeBase64Url(token)];
}

/** Whether a subprotocol name belongs to LiveThing, so `socket.protocol` hides it. */
export function isLiveThingSubprotocol(name: string): boolean {
  return name === LIVETHING_SUBPROTOCOL || name.startsWith(TOKEN_SUBPROTOCOL_PREFIX);
}
