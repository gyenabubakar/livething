/**
 * Thrown when the framework is misconfigured at the source level — for example,
 * when a validator returns a Promise but only sync validators are supported.
 *
 * This is a developer mistake, not a runtime input failure, so the engine
 * lets it propagate up rather than routing it through `onValidationError`.
 */
export class WskitConfigError extends Error {
  readonly __wskitConfig = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'WskitConfigError';
  }
}

/** Type guard for `WskitConfigError`, robust across realm boundaries. */
export function isWskitConfigError(error: unknown): error is WskitConfigError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { __wskitConfig?: unknown }).__wskitConfig === true
  );
}

/**
 * Throw if `result` is a Promise. Used to enforce that validators (Standard
 * Schema or plain functions) run synchronously — wskit does not currently
 * support async validation in the message pipeline or in `error()` factories.
 */
export function assertSyncResult<T>(result: T | Promise<T>, label: string): T {
  if (result && typeof (result as Promise<T>).then === 'function') {
    throw new WskitConfigError(
      `[wskit] async validators are not supported (${label}). Use a sync schema or parse function.`,
    );
  }
  return result as T;
}
