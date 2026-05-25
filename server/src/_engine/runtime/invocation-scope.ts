import { flushDirtyAttachment } from '~/_engine/runtime/hibernation.ts';
import type { EngineCore } from '~/_engine/core.ts';

/**
 * Run one engine entry point (an incoming message, an alarm fire, a close
 * event, etc.) with hibernation writes held back until the end.
 *
 * While the entry point is running, every call that would normally write a
 * connection's row to SQL just adds the connection to a list. When the entry
 * point finishes, the list is walked and each connection's row is written
 * once. So a handler that joins five channels in a row produces one row
 * write, not five.
 *
 * If the same entry point calls back into another entry point (the inner
 * call also wraps itself with this helper), the inner call shares the same
 * list and does not flush — only the outermost call flushes, so the whole
 * chain ends with one row write per touched connection.
 *
 * The flush runs in a `finally` block, so a handler that throws still gets
 * its already-queued writes committed.
 */
export async function withInvocationScope<T>(
  core: EngineCore,
  fn: () => Promise<T> | T,
): Promise<T> {
  const isOuter = core.invocationScope === null;
  if (isOuter) {
    core.invocationScope = { dirtyConnections: new Set() };
  }
  try {
    return await fn();
  } finally {
    if (isOuter) {
      const scope = core.invocationScope!;
      // Drop the scope reference first so the flush writes go straight to
      // SQL. Otherwise each flush would re-add itself to the list we are
      // walking and loop forever.
      core.invocationScope = null;
      for (const connection of scope.dirtyConnections) {
        flushDirtyAttachment(core, connection);
      }
    }
  }
}
