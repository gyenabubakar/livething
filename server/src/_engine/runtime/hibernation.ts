import * as ConnectionStore from '~/_engine/runtime/connection-store.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Save the current connection state to storage and (on hibernation adapters)
 * a tiny attachment with the id so the wake path can find the row. Skipped
 * during the accept window — `onConnect` writes flush once at the end so a
 * handler that joins ten channels writes one row, not ten.
 */
export function persistAttachment(core: EngineCore, connection: RuntimeConnection): void {
  if (connection.pendingWrites?.active) return;
  if (!core.hibernationEnabled) return;
  ConnectionStore.writeConnectionRow(
    core.requireStorage().sql,
    ConnectionStore.buildConnectionRow(connection),
  );
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
