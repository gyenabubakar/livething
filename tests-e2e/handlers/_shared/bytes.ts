// Test bytes that the binary server definition and the client tests both make, so a test
// knows the exact bytes the other side sends.

export function pattern(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed * 7 + (i >> 8)) % 256;
  return bytes;
}
