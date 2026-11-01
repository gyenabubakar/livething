/**
 * Thrown when the framework is misconfigured at the source level — for example,
 * when a validator returns a Promise but only sync validators are supported.
 *
 * This is a developer mistake, not a runtime input failure, so the engine
 * lets it propagate up rather than routing it through `onError`.
 */
export class LiveThingConfigError extends Error {
  readonly __livethingConfig = true as const;

  constructor(message: string) {
    super(`[livething] ${message}`);
    this.name = 'LiveThingConfigError';
  }
}

/** Type guard for `LiveThingConfigError`, robust across realm boundaries. */
export function isLiveThingConfigError(error: unknown): error is LiveThingConfigError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { __livethingConfig?: unknown }).__livethingConfig === true
  );
}

/**
 * If `error` is a `LiveThingConfigError`, rethrow it immediately. Otherwise return
 * normally so the caller can run its own error routing.
 *
 * Use this at the start of every `catch` block that wraps validator calls or
 * the inbound dispatch pipeline. Config errors must always propagate to the
 * caller; routing them through `onError` would suppress
 * the developer-facing signal that something is misconfigured.
 */
export function rethrowIfConfigError(error: unknown): void {
  if (isLiveThingConfigError(error)) throw error;
}

/**
 * Reject a Promise returned from an API that must finish before its caller
 * returns. The rejected Promise is observed so the synchronous configuration
 * error remains the only reported failure. Validators and callbacks use
 * different messages because they point developers at different fixes.
 */
export function assertSynchronousResult<T>(
  result: T | PromiseLike<T>,
  label: string,
  kind: 'validator' | 'callback' = 'callback',
): T {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new LiveThingConfigError(
      kind === 'validator'
        ? `async validators are not supported (${label}). Use a sync schema or parse function.`
        : `async callbacks are not supported (${label}). Use a synchronous callback.`,
    );
  }

  return result as T;
}
