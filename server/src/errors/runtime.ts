import { InternalError, WskitError } from '@wskit/core';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';

/**
 * Runtime surface for sending normalised `__error__` frames.
 */
interface RuntimeErrorDeps {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  /**
   * Resolve a scope from the `__wskit` routing markers carried alongside a
   * runtime error so the hook context can carry `ctx.namespace` or
   * `ctx.channel`. Returns undefined when no scope can be derived.
   */
  resolveScopeFromRouting?(routing: Protocol.WskitRouting): ResolvedScope | undefined;
  declaredErrorCodes: ReadonlySet<string>;
  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];
  logger: Pick<Logger, 'warn' | 'error'>;
  sendProtocolMessage(
    connection: RuntimeConnection,
    opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
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
 * Split a thrown value into the `payload` and `__wskit` halves of wskit's
 * `__error__` protocol frame. `payload` carries `code` (and `detail` when the
 * error has one); `__wskit` carries the routing markers so the client can
 * correlate the failure with its pending operation.
 */
export function normalizeRuntimeError(
  error: unknown,
  routing?: Protocol.WskitRouting,
): { payload: Record<string, unknown>; wskit: Record<string, unknown> } {
  const wskit: Record<string, unknown> = { ...(routing ?? {}) };

  if (error instanceof WskitError) {
    return { payload: { code: error.code, detail: error.detail }, wskit };
  }

  return { payload: { code: InternalError.code }, wskit };
}

export interface SendRuntimeErrorOptions {
  error: unknown;
  event?: string;
  routing?: Protocol.WskitRouting;
}

/**
 * Run `onError(...)` hooks for internal errors, then send the normalized
 * `__error__` protocol frame to the client.
 */
export async function sendRuntimeError(
  deps: RuntimeErrorDeps,
  connection: RuntimeConnection,
  options: SendRuntimeErrorOptions,
): Promise<void> {
  const { error, event, routing } = options;
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
      // A throwing hook must never block the `__error__` frame from reaching
      // the client — otherwise request Promises hang and stream onError
      // callbacks never fire. Hooks are observational; isolate failures here
      // and continue to the remaining hooks plus the protocol send below.
      deps.logger.error('[wskit] onError hook threw; sending __error__ to client anyway', {
        event,
        error: hookError instanceof Error ? hookError.message : String(hookError),
      });
    }
  }

  const { payload, wskit } = normalizeRuntimeError(error, routing);
  deps.sendProtocolMessage(connection, { event: '__error__', payload, wskit });
}

export interface NotifyValidationErrorOptions {
  event: string;
  validationError: unknown;
  scope?: ResolvedScope;
}

/**
 * Notify `onValidationError(...)` hooks for one failed incoming payload.
 *
 * This does not decide whether the client receives `__error__`; it only tells
 * the registered validation hooks that validation failed.
 */
export async function notifyValidationError(
  deps: ValidationErrorDeps,
  connection: RuntimeConnection,
  options: NotifyValidationErrorOptions,
): Promise<void> {
  const { event, validationError, scope } = options;
  if (deps.validationErrorHooks.length === 0) return;

  const ctx = deps.buildConnectionContext(connection, scope);

  for (const hook of deps.validationErrorHooks) {
    await hook(ctx, event, validationError);
  }
}
