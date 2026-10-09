const ASYNC_TRANSACTION_MESSAGE =
  '[livething] sql.transaction() callbacks must be synchronous. Run async work before or after the transaction.';

/**
 * Throw if `fn` is an `async` function. Call it before a transaction starts, so the callback
 * never runs and writes nothing outside the transaction.
 */
export function rejectAsyncTransactionCallback(fn: unknown): void {
  if (
    typeof fn === 'function' &&
    Object.getPrototypeOf(fn)?.constructor?.name === 'AsyncFunction'
  ) {
    throw new TypeError(ASYNC_TRANSACTION_MESSAGE);
  }
}

/**
 * Throw if a transaction callback returned a promise, or any object or function with a `then`
 * method. Call it before the transaction commits, so the transaction rolls back.
 *
 * The thrown error replaces the promise, so nobody else will wait for it. If a native promise
 * rejects later, Node treats that as an unhandled rejection and stops the process, so a
 * handler is attached to it first. Another thenable is left alone: calling its `then` can
 * start work, as a query builder runs its query when awaited.
 */
export function rejectAsyncTransactionResult(result: unknown): void {
  const isObjectLike = typeof result === 'object' || typeof result === 'function';
  if (!isObjectLike || result === null) return;

  if (typeof (result as { then?: unknown }).then !== 'function') return;

  markPromiseHandled(result);
  throw new TypeError(ASYNC_TRANSACTION_MESSAGE);
}

/**
 * Attach a no-op rejection handler to a native promise that LiveThing refuses and throws away,
 * so a later rejection does not stop a Node process. Any other value is left alone, because
 * calling a custom thenable's `then` can start work.
 */
export function markPromiseHandled(value: unknown): void {
  // The built-in then() never calls the object's own then(), so a custom thenable (even one
  // tagged 'Promise' with Symbol.toStringTag) runs no code: then() throws on anything that is not
  // a real promise, from any realm.
  try {
    Promise.prototype.then.call(value, undefined, () => {});
  } catch {
    // Not a native promise: nothing to mark.
  }
}
