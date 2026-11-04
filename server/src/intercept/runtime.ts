/* oxlint-disable @typescript-eslint/no-explicit-any */
import { withConnectionCall } from '~/_engine/async-context.ts';
import { parsePluginWireName } from '~/plugin-scope.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type { CallDescriptor } from '~/_engine/call-context.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { APP_HOOK_OWNER } from './intercept.ts';
import type { FrameOwner, InterceptFrame, InterceptPrimitive } from './intercept.ts';

interface InterceptRuntime {
  asyncContext: EngineAsyncContext;
}

/** Returns the dispatch-shared connection context, building it on first call. */
type GetContext = () => Record<PropertyKey, unknown>;

export interface RunInterceptsOptions {
  intercepts: readonly InterceptPrimitive[];

  frame: InterceptFrame;

  getCtx: GetContext;

  /** How `context.*` should describe the `ctx` these intercepts receive. */
  call?: CallDescriptor;
}

/**
 * Run every intercept in registration order.
 *
 * Each intercept sees the frame *before* schema validation. The returned value
 * (when not `undefined`) becomes the new `payload` for the next intercept and
 * eventually for the validator. The event name and routing are locked.
 *
 * Throwing inside an intercept stops the chain — the error propagates to the
 * engine's normal error handling (e.g. `Block`, `Skip`, typed errors).
 */
export async function runIntercepts(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  options: RunInterceptsOptions,
): Promise<InterceptFrame> {
  const { intercepts, frame, getCtx } = options;
  if (intercepts.length === 0) return frame;

  const call: CallDescriptor = options.call ?? { kind: 'connection', getCtx };

  const ctx = getCtx();
  let nextFrame = frame;
  // A plugin sees its own frames with the short name it declared.
  const parsed = parsePluginWireName(frame.event);

  for (const intercept of intercepts) {
    const hookOwner: FrameOwner = intercept.__owner ?? APP_HOOK_OWNER;
    const ownFrame =
      hookOwner.kind === 'plugin' &&
      nextFrame.owner.kind === 'plugin' &&
      hookOwner.id === nextFrame.owner.id;
    const presented = ownFrame && parsed ? { ...nextFrame, event: parsed.name } : nextFrame;

    const next = await withConnectionCall(
      runtime.asyncContext,
      { ...call, connectionId: connection.id },
      () => intercept.handler(ctx, presented),
    );

    if (next !== undefined) {
      nextFrame = {
        event: nextFrame.event,
        payload: next,
        kind: nextFrame.kind,
        routing: nextFrame.routing,
        owner: nextFrame.owner,
        size: nextFrame.size,
      };
    }
  }

  return nextFrame;
}
