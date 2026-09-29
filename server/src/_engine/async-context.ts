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

/** The engine's store, plus the id of the `base` its definition was assembled from. */
export type EngineAsyncContext = AsyncContext<EngineAsyncContextStore> & {
  readonly baseId?: symbol;
};

export function createAsyncContext(
  factory: AsyncContextFactory,
  baseId?: symbol,
): EngineAsyncContext {
  registerCallContext(factory);
  return Object.assign(factory<EngineAsyncContextStore>(), { baseId });
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

/** Run `fn` so `context.*` can reach a `ctx`. Used directly for code with no connection (init, task, shutdown, upgrade). */
export function withCallContext<T>(
  asyncContext: EngineAsyncContext | undefined,
  call: CallDescriptor,
  fn: () => T,
): T {
  return runInCall({ ...call, baseId: asyncContext?.baseId }, fn);
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
