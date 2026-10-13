import { registerCallContext, runInCall } from '~/_engine/call-context.ts';
import type { CallDescriptor } from '~/_engine/call-context.ts';
import type { ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext, AsyncContextFactory, SQLProvider } from '~/context.ts';

export const INVOCATION_SCOPE = Symbol('livething.invocationScope');

/**
 * One deferred storage write batched for the end of the current invocation.
 * The owning feature (replay) builds the entry and carries its own `flush`, so
 * the engine drains the queue without knowing what kind of row it holds.
 */
export interface PendingScopeFlush {
  flush: (sql: Pick<SQLProvider, 'exec'>) => void;
}

export interface InvocationScopeState {
  dirtyConnections: Set<RuntimeConnection>;
  /** Shared by every open scope of one engine, so a later handler merges into queued values. */
  pendingSnapshotFlushes: Map<string, PendingScopeFlush>;
}

export interface EngineAsyncContextStore {
  connectionId?: string;
  [INVOCATION_SCOPE]?: InvocationScopeState;
}

export type EngineAsyncContext = AsyncContext<EngineAsyncContextStore>;

/**
 * The id of the `base` each engine's definition was assembled from. It is kept beside the
 * adapter's context, not written onto it, because the adapter owns that object and may
 * have frozen it.
 */
const baseIds = new WeakMap<EngineAsyncContext, symbol | undefined>();

export function createAsyncContext(
  factory: AsyncContextFactory,
  baseId?: symbol,
): EngineAsyncContext {
  registerCallContext(factory);
  const asyncContext = factory<EngineAsyncContextStore>();
  baseIds.set(asyncContext, baseId);

  return asyncContext;
}

/**
 * Run `fn` with `connectionId` recorded as the active connection so engine
 * helpers called inside it — notably a plugin's `getState()` — resolve to the
 * right connection even while other connections' handlers interleave.
 */
export function withConnectionContext<T>(
  asyncContext: EngineAsyncContext | undefined,
  connectionId: string,
  fn: () => T,
): T {
  if (!asyncContext) return fn();

  const current = asyncContext.getStore();
  return asyncContext.run({ ...current, connectionId }, fn);
}

/** A {@link CallDescriptor} for code that runs for one connection. */
export interface ConnectionCall extends CallDescriptor {
  readonly connectionId: string;
}

/**
 * Wrap a stream's generator so `next`, `return` and `throw` all run in `call`. A cancel, a
 * channel leave and a disconnect end the generator with `return()` from outside the loop
 * that advances it, and its `finally` block can use `context.*` only if that runs in the
 * stream's call context too.
 */
export function inConnectionCall(
  asyncContext: EngineAsyncContext | undefined,
  call: ConnectionCall,
  generator: AsyncGenerator<unknown, void, unknown>,
): AsyncGenerator<unknown, void, unknown> {
  const wrapped = {
    next: (value: unknown) => withConnectionCall(asyncContext, call, () => generator.next(value)),
    return: (value: void | PromiseLike<void>) =>
      withConnectionCall(asyncContext, call, () => generator.return(value)),
    throw: (error: unknown) => withConnectionCall(asyncContext, call, () => generator.throw(error)),
    [Symbol.asyncIterator]: () => wrapped,
  } as AsyncGenerator<unknown, void, unknown>;

  return wrapped;
}

/**
 * Like {@link withConnectionContext}, and also makes the running `ctx` reachable
 * through `context.*`.
 */
export function withConnectionCall<T>(
  asyncContext: EngineAsyncContext | undefined,
  call: ConnectionCall,
  fn: () => T,
): T {
  return withCallContext(asyncContext, call, () =>
    withConnectionContext(asyncContext, call.connectionId, fn),
  );
}

/**
 * Run `fn` so `context.*` can reach a `ctx`. Used directly for code that has no connection
 * (init, task, shutdown, upgrade) and for the channel gate and lifecycle hooks.
 */
export function withCallContext<T>(
  asyncContext: EngineAsyncContext | undefined,
  call: CallDescriptor,
  fn: () => T,
): T {
  const baseId = call.baseId ?? (asyncContext ? baseIds.get(asyncContext) : undefined);

  return runInCall({ ...call, baseId }, fn);
}

/** One connection and the `ctx` that code running for it receives. */
export interface ConnectionCtxTarget {
  readonly connectionId: string;
  readonly ctx: unknown;
}

/**
 * Run `fn` as code for one connection outside any channel, so `context.connection(base)` returns
 * that connection's `ctx`. Hooks such as `onError` and `onConnect` run this way.
 */
export function withConnectionLevelCall<T>(
  asyncContext: EngineAsyncContext | undefined,
  target: ConnectionCtxTarget,
  fn: () => T,
): T {
  return withConnectionCall(
    asyncContext,
    connectionCall(target.connectionId, undefined, () => target.ctx),
    fn,
  );
}

/** Describe a connection's `ctx`: a channel `ctx` inside a channel scope, a connection `ctx` outside one. */
export function connectionCall(
  connectionId: string,
  scope: ResolvedChannel | undefined,
  getCtx: () => unknown,
): ConnectionCall {
  return scope?.channel
    ? { kind: 'channel', getCtx, channelKey: scope.channel.key, connectionId }
    : { kind: 'connection', getCtx, connectionId };
}

export function getInvocationScope(
  asyncContext: EngineAsyncContext | undefined,
  fallback: InvocationScopeState | null = null,
): InvocationScopeState | null {
  const store = asyncContext?.getStore();
  return store?.[INVOCATION_SCOPE] ?? fallback;
}

export function withAsyncInvocationScope<T>(
  asyncContext: EngineAsyncContext | undefined,
  scope: InvocationScopeState,
  fn: () => T,
): T {
  if (!asyncContext) return fn();

  const current = asyncContext.getStore();
  return asyncContext.run({ ...current, [INVOCATION_SCOPE]: scope }, fn);
}
