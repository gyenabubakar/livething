import { assertSynchronousResult } from '@wskit/core';
import { getInvocationScope } from '~/_engine/async-context.ts';
import * as ConnectionStore from '~/_engine/runtime/connection-store.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Save the connection's hibernation row. There are three reasons this can
 * skip writing right now:
 *
 * - `pendingWrites.active` is on during `onConnect`, so a handler that
 *   joins ten channels writes one row at the end, not ten along the way.
 * - an invocation scope is open during any engine entry point, so all
 *   the row writes that handler triggers queue up and flush once at the end.
 * - The fingerprint check inside `flushDirtyAttachment` skips the SQL call
 *   when the row's data has not actually changed since the last write.
 */
export function persistAttachment(core: EngineCore, connection: RuntimeConnection): void {
  if (connection.pendingWrites?.active) return;
  if (!core.hibernationEnabled) return;
  if (connection.closing) return;

  const scope = getInvocationScope(core.asyncContext);
  if (scope) {
    scope.dirtyConnections.add(connection);
    return;
  }

  flushDirtyAttachment(core, connection);
}

/**
 * Write the row to SQL right now, skipping the invocation-scope queue.
 * Called by the scope flusher and by code paths that need the row on disk
 * before control returns. The fingerprint check still applies, so a flush
 * that matches what is already on disk does no SQL work.
 */
export function flushDirtyAttachment(core: EngineCore, connection: RuntimeConnection): void {
  if (!core.hibernationEnabled) return;
  if (connection.closing) return;

  let row: ConnectionStore.StoredConnectionRow;
  let fingerprint: string;
  try {
    row = ConnectionStore.buildConnectionRow(connection);
    fingerprint = JSON.stringify(row);
  } catch (error) {
    core.logger.error('[wskit] failed to persist translator state', {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
    connection.closing = true;
    connection.descriptor.close(1011, '[wskit] translator state could not be persisted');
    return;
  }
  if (connection.lastPersistedFingerprint === fingerprint) return;

  ConnectionStore.writeConnectionRow(core.storage.sql, row);
  // Cheap adapter call that updates the in-memory hibernation tag. Runs once
  // per SQL write — when the SQL write is skipped, this is skipped too.
  const persistResult = core.options.hibernation?.persist(connection.wsKey, { id: connection.id });
  assertSynchronousResult(persistResult, 'adapter hibernation.persist');
  connection.lastPersistedFingerprint = fingerprint;
}

/**
 * Load one persisted connection row by id, or `null` if it is gone. Used by
 * the wake path to rebuild in-memory state.
 */
export function readConnectionState(
  core: EngineCore,
  connectionId: string,
): ConnectionStore.StoredConnectionRow | null {
  if (!core.hibernationEnabled) return null;
  const preloaded = core.preloadedConnectionRows;
  if (preloaded) return preloaded.get(connectionId) ?? null;
  return ConnectionStore.readConnectionRow(core.storage.sql, connectionId);
}

/**
 * Read every persisted row once and serve the boot restore's per-socket lookups
 * from it, so waking N sockets costs one query rather than N. The callback owns
 * the whole restore pass; the preload is dropped afterwards so later wakes go
 * back to reading live rows.
 */
export function withPreloadedConnectionRows(core: EngineCore, run: () => void): void {
  if (!core.hibernationEnabled) {
    run();
    return;
  }
  core.preloadedConnectionRows = ConnectionStore.readAllConnectionRows(core.storage.sql);
  try {
    run();
  } finally {
    core.preloadedConnectionRows = undefined;
  }
}

/**
 * Delete a connection's saved hibernation state — the record the engine reads to
 * rebuild it when a hibernated object wakes. No-op without hibernation.
 */
export function deleteConnectionState(core: EngineCore, connectionId: string): void {
  if (!core.hibernationEnabled) return;
  // Drop this connection's pending row write first — without it, the write that
  // runs when this engine call finishes would re-create the row we just deleted.
  const scope = getInvocationScope(core.asyncContext);
  if (scope) {
    for (const connection of scope.dirtyConnections) {
      if (connection.id === connectionId) {
        scope.dirtyConnections.delete(connection);
        break;
      }
    }
  }
  ConnectionStore.deleteConnectionRow(core.storage.sql, connectionId);
}

/**
 * Boot cleanup. Drop every persisted row whose id is not in `surviving`.
 * Adapters call this with the sockets the platform still holds (empty = wipe).
 */
export function reconcileConnections(core: EngineCore, surviving: ReadonlySet<string>): void {
  if (!core.hibernationEnabled) return;
  ConnectionStore.reconcileConnectionRows(core.storage.sql, surviving);
}
