import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext, AsyncContextFactory, SQLProvider } from '~/context.ts';
import type { ReplayRow } from '~/replay/types.ts';

export const INVOCATION_SCOPE = Symbol('wskit.invocationScope');

export interface InvocationScopeState {
  dirtyConnections: Set<RuntimeConnection>;
  pendingReplaySnapshotRows: Map<
    string,
    {
      row: ReplayRow | null;
      postFlush: (sql: Pick<SQLProvider, 'exec'>) => void;
    }
  >;
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
