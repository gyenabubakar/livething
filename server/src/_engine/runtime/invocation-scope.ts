import { flushDirtyAttachment } from '~/_engine/runtime/hibernation.ts';
import { deleteReplayRow, storeReplayRow } from '~/replay/runtime.ts';
import type { EngineCore } from '~/_engine/core.ts';

/**
 * Wrap one user-facing engine callback (the engine's handler for an
 * incoming WebSocket message, a WebSocket close, a WebSocket error, or a
 * scheduled alarm fire) so its SQL writes batch up and run at the end of
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
 * 2. Each snapshot-mode replay write is added to `pendingReplaySnapshotRows`
 *    under the row key the snapshot maps to. When a later write in the same
 *    handler targets the same key, the new value replaces (or is merged
 *    with) the old one in memory. At the end, each key writes one row.
 *
 * When the callback finishes, the two lists are walked and one SQL write
 * happens per dirty connection and per unique snapshot key. So a handler
 * that fires fifty messages all targeting the same snapshot key produces
 * one row write, not fifty.
 *
 * If the same callback synchronously calls back into another callback the
 * engine has also wrapped (for example an alarm fire that immediately
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
  const isOuter = core.invocationScope === null;
  if (isOuter) {
    core.invocationScope = {
      dirtyConnections: new Set(),
      pendingReplaySnapshotRows: new Map(),
    };
  }
  try {
    return await fn();
  } finally {
    if (isOuter) {
      const scope = core.invocationScope!;
      // Drop the scope reference before the flush. If we left it set, every
      // flush call below would see the scope is still open and re-add the
      // connection or row to the list we are walking, which would loop
      // forever.
      core.invocationScope = null;
      for (const connection of scope.dirtyConnections) {
        flushDirtyAttachment(core, connection);
      }
      if (scope.pendingReplaySnapshotRows.size > 0) {
        const sql = core.storageOrUndefined()?.sql;
        if (sql) {
          for (const [rowKey, entry] of scope.pendingReplaySnapshotRows) {
            if (entry.row === null) deleteReplayRow(sql, rowKey);
            else storeReplayRow(sql, entry.row);
            // Run the per-row clean-up the queue entry carried with it
            // (replay's retention prune, for example). It runs AFTER the
            // write above so it sees the row actually on disk and counts
            // it when deciding whether to drop the oldest rows.
            entry.postFlush(sql);
          }
        }
      }
    }
  }
}
