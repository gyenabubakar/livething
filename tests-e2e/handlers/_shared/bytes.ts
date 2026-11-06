// Test bytes that the binary server definition and the client tests both make, so a test
// knows the exact bytes the other side sends.

export function pattern(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed * 7 + (i >> 8)) % 256;
  return bytes;
}

/** FNV-1a over every byte, so a test compares the whole bytes, not a few of them. */
export function hash(bytes: Uint8Array): string {
  let value = 0x811c9dc5;
  for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value.toString(16);
}
