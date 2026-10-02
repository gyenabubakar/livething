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
 */
export function rejectAsyncTransactionResult(result: unknown): void {
  const isObjectLike = typeof result === 'object' || typeof result === 'function';
  if (
    isObjectLike &&
    result !== null &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    throw new TypeError(ASYNC_TRANSACTION_MESSAGE);
  }
}
