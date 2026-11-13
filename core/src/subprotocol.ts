/** The plain subprotocol name. A client offers it only together with a token. */
export const LIVETHING_SUBPROTOCOL = 'livething-v1';

/** The token subprotocol is this prefix followed by the base64url-encoded token. */
export const TOKEN_SUBPROTOCOL_PREFIX = `${LIVETHING_SUBPROTOCOL}.token.`;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUES = new Map([...ALPHABET].map((char, index) => [char, index]));

// `Uint8Array.prototype.toBase64` is too new for Node 22 and 24, so LiveThing encodes by hand.
/** Encodes text as UTF-8, then as base64url with no padding. */
export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET[(chunk >> (18 - c * 6)) & 63];
  }

  return out;
}

/** Decodes unpadded base64url to UTF-8 text, or `null` when it is not valid. */
export function decodeBase64Url(encoded: string): string | null {
  if (encoded.length % 4 === 1) return null;

  const bytes = new Uint8Array(Math.floor((encoded.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of encoded) {
    const value = VALUES.get(char);
    if (value === undefined) return null;

    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }

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
