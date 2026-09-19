import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
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
  pendingSnapshotFlushes: Map<string, PendingScopeFlush>;
}

export interface EngineAsyncContextStore {
  connectionId?: string;
  [INVOCATION_SCOPE]?: InvocationScopeState;
}

export type EngineAsyncContext = AsyncContext<EngineAsyncContextStore>;

export function createAsyncContext(factory: AsyncContextFactory): EngineAsyncContext {
  return factory<EngineAsyncContextStore>();
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
