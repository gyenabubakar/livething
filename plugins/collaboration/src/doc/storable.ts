// What a doc can hold as a value. No imports, so the shared entry, which checks defaults with
// it, does not load Yjs.

/** How deep a value may nest. */
export const MAX_DEPTH = 64;

/** Half of an emoji or other pair, alone: UTF-8 can't hold it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** An array with an empty slot, such as `new Array(2)`. Yjs and JSON can't hold one. */
export function hasHoles(array: readonly unknown[]): boolean {
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index)) return true;
  }

  return false;
}

/**
 * A string Yjs sends as it is. Yjs encodes strings as UTF-8, which turns a lone surrogate
 * into U+FFFD, so the writer's copy would differ from every other copy for good.
 */
export function wellFormed(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/** `text` with each lone surrogate as U+FFFD, as every other copy would get it. */
export function toWellFormed(text: string): string {
  return text.replace(new RegExp(LONE_SURROGATE.source, 'g'), '�');
}

/** JSON or bytes, as a Yjs update can carry it. `undefined` stands for "no value". */
export function isStorable(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;

  if (value === null || value === undefined) return true;

  switch (typeof value) {
    case 'boolean':
      return true;

    case 'string':
      return wellFormed(value);

    case 'number':
      return Number.isFinite(value);

    case 'object':
      // Yjs takes a plain Uint8Array only: not a subclass such as a Node Buffer.
      if (value instanceof Uint8Array) return Object.getPrototypeOf(value) === Uint8Array.prototype;

      if (Array.isArray(value)) {
        return !hasHoles(value) && value.every((item) => isStorable(item, depth + 1));
      }

      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;

      // A peer decoding `__proto__` sets a prototype, not a key, so the value would differ.
      if (Object.hasOwn(value, '__proto__')) return false;

      for (const [key, item] of Object.entries(value)) {
        if (!wellFormed(key) || !isStorable(item, depth + 1)) return false;
      }

      return true;

    default:
      return false;
  }
}
