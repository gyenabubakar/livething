import { InternalError, WskitError } from '@wskit/core';
import type { ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';

/**
 * Runtime surface for sending normalised `_error` messages.
 */
interface RuntimeErrorDeps {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  declaredErrorCodes: ReadonlySet<string>;
  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];
  logger: {
    warn(message: string, data?: unknown): void;
  };
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
}

/**
 * Runtime surface for validation-error fanout.
 */
interface ValidationErrorDeps {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  validationErrorHooks: readonly ((
    ctx: unknown,
    event: string,
    validationError: unknown,
  ) => void | Promise<void>)[];
}

/**
 * Convert any thrown value into the wire payload used by wskit's `_error`
 * protocol event.
 */
export function normalizeRuntimeErrorPayload(
  error: unknown,
  routing?: Record<string, unknown>,
): Record<string, unknown> {
  if (error instanceof WskitError) {
    return { code: error.code, detail: error.detail, ...routing };
  }

  return { code: InternalError.code, ...routing };
}

/**
 * Run `onError(...)` hooks for internal errors, then send the normalized
 * `_error` protocol message to the client.
 */
export async function sendRuntimeError(
  deps: RuntimeErrorDeps,
  connection: RuntimeConnection,
  error: unknown,
  event?: string,
  routing?: Record<string, unknown>,
): Promise<void> {
  if (error instanceof WskitError && !deps.declaredErrorCodes.has(error.code)) {
    deps.logger.warn('[wskit] Thrown WskitError was not declared with errors(...)', {
      code: error.code,
      event,
    });
  }

  for (const hook of deps.errorHooks) {
    const ctx = deps.buildConnectionContext(connection);
    await hook(ctx, error, event);
  }

  deps.sendProtocolMessage(connection, '_error', normalizeRuntimeErrorPayload(error, routing));
}

/**
 * Notify `onValidationError(...)` hooks for one failed incoming payload.
 *
 * This does not decide whether the client receives `_error`; it only tells the
 * registered validation hooks that validation failed.
 */
export async function notifyValidationError(
  deps: ValidationErrorDeps,
  connection: RuntimeConnection,
  event: string,
  validationError: unknown,
  scope?: ResolvedScope,
): Promise<void> {
  if (deps.validationErrorHooks.length === 0) return;

  const ctx = deps.buildConnectionContext(connection, scope);

  for (const hook of deps.validationErrorHooks) {
    await hook(ctx, event, validationError);
  }
}
