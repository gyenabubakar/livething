/**
 * Thrown when the framework is misconfigured at the source level — for example,
 * when a validator returns a Promise but only sync validators are supported.
 *
 * This is a developer mistake, not a runtime input failure, so the engine
 * lets it propagate up rather than routing it through `onValidationError`.
 */
export class WSKitConfigError extends Error {
  readonly __wskitConfig = true as const;

  constructor(message: string) {
    super(`[wskit] ${message}`);
    this.name = 'WSKitConfigError';
  }
}

/** Type guard for `WSKitConfigError`, robust across realm boundaries. */
export function isWSKitConfigError(error: unknown): error is WSKitConfigError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { __wskitConfig?: unknown }).__wskitConfig === true
  );
}

/**
 * If `error` is a `WSKitConfigError`, rethrow it immediately. Otherwise return
 * normally so the caller can run its own error routing.
 *
 * Use this at the start of every `catch` block that wraps validator calls or
 * the inbound dispatch pipeline. Config errors must always propagate to the
 * caller; routing them through `onValidationError` or `onError` would suppress
 * the developer-facing signal that something is misconfigured.
 */
export function rethrowIfConfigError(error: unknown): void {
  if (isWSKitConfigError(error)) throw error;
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
    throw new WSKitConfigError(
      kind === 'validator'
        ? `async validators are not supported (${label}). Use a sync schema or parse function.`
        : `async callbacks are not supported (${label}). Use a synchronous callback.`,
    );
  }
  return result as T;
}
