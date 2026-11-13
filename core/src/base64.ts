const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUES = new Map([
  ...[...STANDARD].map((char, index) => [char, index] as const),
  ['-', 62],
  ['_', 63],
]);

// `Uint8Array.prototype.toBase64` is too new for Node 22 and 24, so LiveThing encodes by hand.
/** Encodes bytes as base64 with padding, or as base64url with no padding when `url` is true. */
export function encodeBase64(bytes: Uint8Array, url = false): string {
  const alphabet = url ? URL_SAFE : STANDARD;
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += alphabet[(chunk >> (18 - c * 6)) & 63];
    if (!url) out += '='.repeat(4 - chars);
  }

  return out;
}

/** Decodes base64 or base64url, with or without padding, or returns `null` when it is not valid. */
export function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> | null {
  const text = encoded.replace(/={1,2}$/, '');
  if (text.length % 4 === 1) return null;

  const bytes = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = VALUES.get(char);
    if (value === undefined) return null;

    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }

  return bytes;
}
