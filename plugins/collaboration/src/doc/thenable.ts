/**
 * A Promise, or any object with a `then`, as a library or another realm can return from an
 * asynchronous check. `instanceof Promise` misses the second kind. Kept apart from the doc
 * code, so the shared entry, which reads it, does not load Yjs.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}
