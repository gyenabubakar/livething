/**
 * True for any thenable, including a Promise from another realm (iframe, worker)
 * where `instanceof Promise` is false because each realm has its own `Promise`.
 */
export function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}
