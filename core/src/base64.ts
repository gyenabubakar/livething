const STANDARD = codes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const URL_SAFE = codes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
const PAD = 61;

/** The 6-bit value of each ASCII code, or -1. Both alphabets decode. */
const VALUES = new Int8Array(128).fill(-1);
STANDARD.forEach((code, value) => (VALUES[code] = value));
VALUES[45] = 62;
VALUES[95] = 63;

/** Character codes per `String.fromCharCode` call, well under any engine's argument limit. */
const CHARS_PER_CALL = 0x8000;

function codes(alphabet: string): Uint8Array {
  return Uint8Array.from(alphabet, (char) => char.charCodeAt(0));
}

/** The ASCII text of character codes. `TextDecoder` is not on every platform the client runs on. */
function asciiText(chars: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += CHARS_PER_CALL) {
    parts.push(String.fromCharCode.apply(null, chars.subarray(i, i + CHARS_PER_CALL) as never));
  }

  return parts.join('');
}

interface NativeBuffer {
  from(
    buffer: ArrayBufferLike,
    offset: number,
    length: number,
  ): { toString(encoding: string): string };
  isEncoding?(encoding: string): boolean;
}

/**
 * Node's `Buffer`, also on Cloudflare with `nodejs_compat`. It encodes in native code, several
 * times faster than the loop below, which the server feels on every binary event it streams.
 * Bundlers and React Native may add the `buffer` package as a global instead, with no base64url.
 */
const globalBuffer = (globalThis as { Buffer?: NativeBuffer }).Buffer;
const nativeBuffer = globalBuffer?.isEncoding?.('base64url') ? globalBuffer : undefined;

// `Uint8Array.prototype.toBase64` is too new for Node 22 and 24, so LiveThing encodes by hand
// where there is no `Buffer`. It writes the character codes into bytes and turns them into text
// in large pieces: building the string one character at a time takes seconds for a 32 MiB message.
/** Encodes bytes as base64 with padding, or as base64url with no padding when `url` is true. */
export function encodeBase64(bytes: Uint8Array, url = false): string {
  // `Buffer.from` throws on a transferred buffer, even with no bytes to read.
  if (bytes.length === 0) return '';

  if (nativeBuffer) {
    return nativeBuffer
      .from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString(url ? 'base64url' : 'base64');
  }

  const alphabet = url ? URL_SAFE : STANDARD;
  const tail = bytes.length % 3;
  const whole = bytes.length - tail;
  // base64url drops the padding, so its tail is one character more than its bytes.
  const paddedTail = url ? tail + 1 : 4;

  const out = new Uint8Array((whole / 3) * 4 + (tail === 0 ? 0 : paddedTail));
  let o = 0;
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = alphabet[n >> 18]!;
    out[o++] = alphabet[(n >> 12) & 63]!;
    out[o++] = alphabet[(n >> 6) & 63]!;
    out[o++] = alphabet[n & 63]!;
  }

  if (tail > 0) {
    const n = (bytes[whole]! << 16) | (tail === 2 ? bytes[whole + 1]! << 8 : 0);
    out[o++] = alphabet[n >> 18]!;
    out[o++] = alphabet[(n >> 12) & 63]!;
    if (tail === 2) out[o++] = alphabet[(n >> 6) & 63]!;
    else if (!url) out[o++] = PAD;
    if (!url) out[o++] = PAD;
  }

  return asciiText(out);
}

/** Decodes base64 or base64url, with or without padding, or returns `null` when it is not valid. */
export function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> | null {
  let length = encoded.length;
  if (encoded.charCodeAt(length - 1) === PAD) length--;
  if (encoded.charCodeAt(length - 1) === PAD) length--;
  if (length % 4 === 1) return null;

  // Padding only fills the last 4-character group: `AA==` or `AAA=`.
  const padding = encoded.length - length;
  if (padding > 0 && (encoded.length % 4 !== 0 || (length % 4) + padding !== 4)) return null;

  const bytes = new Uint8Array(Math.floor((length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < length; i++) {
    const code = encoded.charCodeAt(i);
    const value = code < 128 ? VALUES[code]! : -1;
    if (value < 0) return null;

    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }

  return bytes;
}
