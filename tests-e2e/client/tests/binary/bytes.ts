// Shared by the page and the spec, so the spec knows the exact bytes the page sends.

export { pattern } from '@livething/tests-e2e-handlers/_shared/bytes';

/** FNV-1a over every byte, so a test compares the whole bytes, not a few of them. */
export function hash(bytes: Uint8Array): string {
  let value = 0x811c9dc5;
  for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value.toString(16);
}
