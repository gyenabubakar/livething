import { assertSynchronousResult } from '@livething/core';
import { getInvocationScope, withAsyncInvocationScope } from '~/_engine/async-context.ts';
import { flushDirtyAttachment } from '~/_engine/runtime/hibernation.ts';
import type { InvocationScopeState } from '~/_engine/async-context.ts';
import type { EngineCore } from '~/_engine/core.ts';

/**
 * Wrap one user-facing engine callback (the engine's handler for an
 * incoming WebSocket message, a WebSocket close, a WebSocket error, or a
 * scheduled callback fire) so its SQL writes batch up and run at the end of
 * the callback instead of one by one as the callback works.
 *
 * While the callback is running, two kinds of writes go into in-memory
 * lists instead of straight to SQL:
 *
 * 1. Each connection whose hibernation row needs saving is added to
 *    `dirtyConnections`. A handler that joins five channels would have
 *    saved the row five times before; with the scope it saves once at the
 *    end.
 *
 * 2. Each snapshot-mode replay write is added to `pendingSnapshotFlushes`
 *    under the row key the snapshot maps to. When a later write targets the
 *    same key, the new value replaces (or is merged with) the old one in
 *    memory. This queue is shared by every open scope of the engine: messages
 *    that arrive back to back open their scopes together, and a handler must
 *    merge into the value an earlier handler queued, not the older row on disk.
 *
 * When the callback finishes, the two lists are walked and one SQL write
 * happens per dirty connection and per unique snapshot key. So a handler
 * that fires fifty messages all targeting the same snapshot key produces
 * one row write, not fifty.
 *
 * If the same callback synchronously calls back into another callback the
 * engine has also wrapped (for example a scheduled callback that immediately
 * closes a connection), the inner call shares the outer lists and does
 * NOT flush. Only the outermost call flushes. That way a long chain still
 * ends with one write per touched connection / key.
 *
 * The flush runs inside a `finally` block. If the handler throws, anything
 * that was already queued before the throw still gets written.
 */
export async function withInvocationScope<T>(
  core: EngineCore,
  fn: () => Promise<T> | T,
): Promise<T> {
  const existing = getInvocationScope(core.asyncContext);
  if (existing) return await fn();

  const scope = createScope(core);

  try {
    return await withAsyncInvocationScope(core.asyncContext, scope, fn);
  } finally {
    flushInvocationScope(core, scope);
  }
}

/**
 * Run a synchronous engine callback with the same batching guarantees as
 * `withInvocationScope`. Hibernation wake is deliberately synchronous: the
 * adapter snapshot, SQL row, and in-memory indexes are all read or updated
 * synchronously, so making this path async would only defer its flush.
 */
export function withInvocationScopeSync<T>(core: EngineCore, fn: () => T): T {
  const existing = getInvocationScope(core.asyncContext);
  if (existing) {
    return assertSynchronousResult(fn(), 'withInvocationScopeSync callback');
  }

  const scope = createScope(core);

  try {
    return assertSynchronousResult(
      withAsyncInvocationScope(core.asyncContext, scope, fn),
      'withInvocationScopeSync callback',
    );
  } finally {
    flushInvocationScope(core, scope);
  }
}

function createScope(core: EngineCore): InvocationScopeState {
  return {
    dirtyConnections: new Set(),
    pendingSnapshotFlushes: core.pendingSnapshotFlushes,
  };
}

function flushInvocationScope(core: EngineCore, scope: InvocationScopeState): void {
  for (const connection of scope.dirtyConnections) {
    flushDirtyAttachment(core, connection);
  }

  if (scope.pendingSnapshotFlushes.size === 0) return;

  // The queue is shared, so this also writes rows that other open scopes
  // queued. Each entry already holds the latest merged value for its key.
  const sql = core.storage.sql;
  for (const [key, entry] of scope.pendingSnapshotFlushes) {
    scope.pendingSnapshotFlushes.delete(key);
    entry.flush(sql);
  }
}
