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
  /**
   * Resolve a scope from the wire routing markers carried alongside a runtime
   * error. The engine looks up `_namespace`, `_channel`, and `_channelScope`
   * against the compiled handler so the hook context can carry `ctx.namespace`
   * or `ctx.channel`. Returns undefined when no scope can be derived.
   */
  resolveScopeFromRouting?(routing: Record<string, unknown>): ResolvedScope | undefined;
  declaredErrorCodes: ReadonlySet<string>;
  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];
  logger: {
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
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

  const scope = routing ? deps.resolveScopeFromRouting?.(routing) : undefined;
  for (const hook of deps.errorHooks) {
    const ctx = deps.buildConnectionContext(connection, scope);
    try {
      await hook(ctx, error, event);
    } catch (hookError) {
      // A throwing hook must never block the `_error` frame from reaching the
      // client — otherwise request Promises hang and stream onError callbacks
      // never fire. Hooks are observational; isolate failures here and
      // continue to the remaining hooks plus the protocol send below.
      deps.logger.error('[wskit] onError hook threw; sending _error to client anyway', {
        event,
        error: hookError instanceof Error ? hookError.message : String(hookError),
      });
    }
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
