import { InternalError, LiveThingError, NotAMember } from '@livething/core';
import { withConnectionLevelCall } from '~/_engine/async-context.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';

type OptsParameter = {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
};

/**
 * Runtime surface for sending normalised `__error__` frames.
 */
interface RuntimeErrorDeps {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedChannel,
  ): Record<PropertyKey, unknown>;

  /**
   * Resolve a scope from the `__livething` routing markers carried alongside a
   * runtime error so the hook context can carry `ctx.channel`. Returns
   * undefined when no scope can be derived.
   */
  resolveScopeFromRouting?(routing: Protocol.LiveThingRouting): ResolvedChannel | undefined;

  declaredErrorCodes: ReadonlySet<string>;

  /** Lets `context.connection(base)` reach the hook's `ctx`. */
  asyncContext?: EngineAsyncContext;

  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];

  logger: Pick<Logger, 'warn' | 'error'>;

  sendProtocolMessage(connection: RuntimeConnection, opts: OptsParameter): void;
}

/**
 * Split a thrown value into the `payload` and `__livething` halves of LiveThing's
 * `__error__` protocol frame. `payload` carries `code` (and `detail` when the
 * error has one); `__livething` carries the routing markers so the client can
 * correlate the failure with its pending operation.
 */
export function normalizeRuntimeError(
  error: unknown,
  routing?: Protocol.LiveThingRouting,
  declaredErrorCodes?: ReadonlySet<string>,
): { payload: Record<string, unknown>; livething: Record<string, unknown> } {
  const livething: Record<string, unknown> = { ...(routing ?? {}) };

  if (error instanceof LiveThingError) {
    // A LiveThingError whose code was never declared in `errors: [...]` is not part
    // of the contract, so `InferClient` can't type it. Handing the raw code to
    // the client would give them a code they can't narrow on; collapse it to
    // `internal-error` instead. (sendRuntimeError logs a dev warning so the
    // missing declaration is still visible server-side.)
    if (declaredErrorCodes && !declaredErrorCodes.has(error.code)) {
      return { payload: { code: InternalError.code }, livething };
    }

    return { payload: { code: error.code, detail: error.detail }, livething };
  }

  return { payload: { code: InternalError.code }, livething };
}

export interface SendRuntimeErrorOptions {
  error: unknown;

  event?: string;

  routing?: Protocol.LiveThingRouting;

  /** The plugin that failed, when the event and routing can't tell, as in its `onConnect`. */
  pluginId?: string;

  /** The socket itself failed, such as a reset connection. No handler threw. */
  fromSocket?: boolean;

  /**
   * Send the `__error__` frame this way, after the hooks ran. A recorded stream uses it to hold
   * the frame back until a continue has sent the stored chunks.
   */
  deliver?: (connection: RuntimeConnection, frame: RuntimeErrorFrame) => void;

  /** What the client gets in place of `internal-error`, for the log. Goes with `deliver`. */
  clientGets?: string;
}

/** The `__error__` frame `sendRuntimeError` sends. */
export interface RuntimeErrorFrame {
  event: '__error__';
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
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
  if (error instanceof LiveThingError && !deps.declaredErrorCodes.has(error.code)) {
    deps.logger.warn(
      // Server-only by design, so the client gets internal-error and a declaration is no fix.
      NotAMember.matches(error)
        ? '[livething] A handler did not catch NotAMember, thrown when ctx.channel.request(..., { to }) targets a connection outside the channel.'
        : '[livething] Thrown LiveThingError was not declared in the contract errors: [...] list',
      {
        code: error.code,
        event,
      },
    );
  }

  // The client only sees `internal-error`, so with no hook to see it the real error would be
  // lost. An `onError` hook replaces this log, as it owns the error from then on. A signal here,
  // such as `RejectAuth` outside `authenticate`, is a mistake and is logged.
  if (options.fromSocket) {
    if (deps.errorHooks.length === 0) {
      deps.logger.warn('[livething] A connection reported a socket error.', { error });
    }
  } else if (!(error instanceof LiveThingError) && deps.errorHooks.length === 0) {
    deps.logger.error(
      `[livething] A handler threw an unexpected error, and the client got ${options.clientGets ?? 'internal-error'}. ` +
        'Add an onError hook to handle such errors yourself.',
      { event, error },
    );
  }

  const scope = routing ? deps.resolveScopeFromRouting?.(routing) : undefined;
  for (const hook of deps.errorHooks) {
    const ctx = deps.buildConnectionContext(connection, scope);
    try {
      await withConnectionLevelCall(deps.asyncContext, { connectionId: connection.id, ctx }, () =>
        hook(ctx, error, event),
      );
    } catch (hookError) {
      // A throwing hook must never block the `__error__` frame from reaching
      // the client — otherwise request Promises hang and stream onError
      // callbacks never fire. Hooks are observational; isolate failures here
      // and continue to the remaining hooks plus the protocol send below.
      deps.logger.error('[livething] onError hook threw; sending __error__ to client anyway', {
        event,
        error: hookError instanceof Error ? hookError.message : String(hookError),
      });
    }
  }

  const { payload, livething } = normalizeRuntimeError(error, routing, deps.declaredErrorCodes);
  const frame: RuntimeErrorFrame = { event: '__error__', payload, livething };
  if (options.deliver) options.deliver(connection, frame);
  else deps.sendProtocolMessage(connection, frame);
}
