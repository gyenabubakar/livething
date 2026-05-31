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

  const row = ConnectionStore.buildConnectionRow(connection);
  const fingerprint = JSON.stringify(row);
  if (connection.lastPersistedFingerprint === fingerprint) return;

  ConnectionStore.writeConnectionRow(core.requireStorage().sql, row);
  connection.lastPersistedFingerprint = fingerprint;
  // Cheap adapter call that updates the in-memory hibernation tag. Runs once
  // per SQL write — when the SQL write is skipped, this is skipped too.
  core.options.hibernation?.persist(connection.wsKey, { id: connection.id });
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
  return ConnectionStore.readConnectionRow(core.requireStorage().sql, connectionId);
}

/** Delete one connection row. Called after disconnect hooks run. */
export function deleteConnectionState(core: EngineCore, connectionId: string): void {
  if (!core.hibernationEnabled) return;
  // Drop any queued write for this connection first. If we did not, the
  // scope flush after this call would write a row back for a connection we
  // just deleted, bringing it back to life on disk.
  const scope = getInvocationScope(core.asyncContext);
  if (scope) {
    for (const connection of scope.dirtyConnections) {
      if (connection.id === connectionId) {
        scope.dirtyConnections.delete(connection);
        break;
      }
    }
  }
  ConnectionStore.deleteConnectionRow(core.requireStorage().sql, connectionId);
}

/**
 * Boot cleanup. Drop every persisted row whose id is not in `surviving`.
 * Adapters call this with the sockets the platform still holds (empty = wipe).
 */
export function reconcileConnections(core: EngineCore, surviving: ReadonlySet<string>): void {
  if (!core.hibernationEnabled) return;
  ConnectionStore.reconcileConnectionRows(core.requireStorage().sql, surviving);
}
