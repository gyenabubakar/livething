import { rescheduleAlarm } from '~/_engine/alarm.ts';
import { clearCacheEntriesForUser } from '~/inbox/receipts-storage.ts';
import { clearInboxForChannel, drainInboxOnReconnect, fanOutToInbox } from '~/inbox/runtime.ts';
import { deleteInboxRowsOutsideScopes } from '~/inbox/storage.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { InboxService } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

/**
 * The inbox fan-out / drain / clear runtime, reached through the engine's
 * `inboxService` slot. Registered once by the `inbox()` capability even when
 * several channels enable inbox — a handler that lists none ships none of this.
 */
const inboxService: InboxService = {
  fanOut(core: EngineCore, opts) {
    fanOutToInbox(core, { ...opts, isUserPurging: (userId) => core.isUserPurging(userId) });
  },
  drainOnReconnect(core: EngineCore, connection: RuntimeConnection) {
    drainInboxOnReconnect(core, connection);
  },
  clearChannel(core: EngineCore, key) {
    clearInboxForChannel(core, key);
  },
};

const INBOX_RUNTIME_KEY = Symbol('inbox-runtime');

export function registerInboxRuntime(engine: EngineAccess): void {
  engine.installOnce(INBOX_RUNTIME_KEY, () => {
    engine.setInboxService(inboxService);

    // Older lightweight access doubles may not expose lifecycle hooks; the
    // real engine always does, but cleanup should not make those doubles fail
    // before they can exercise inbox protocol handlers.
    engine.onBoot?.(() => {
      const scopes = engine.getInboxChannelScopes?.();
      if (scopes) deleteInboxRowsOutsideScopes(engine.storage.sql, scopes);
    });

    engine.onPurgeUser(async (core, userId) => {
      const engineCore = core as EngineCore;
      const failures: unknown[] = [];
      try {
        const { sql } = engineCore.storage;
        sql.transaction(() => {
          tryDelete(
            () => sql.exec('DELETE FROM __livething_inbox WHERE user_id = ?', userId),
            failures,
          );
          tryDelete(
            () => sql.exec('DELETE FROM __livething_inbox_watermark WHERE user_id = ?', userId),
            failures,
          );
          tryDelete(
            () => sql.exec('DELETE FROM __livething_inbox_receipts WHERE user_id = ?', userId),
            failures,
          );
        });
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          clearCacheEntriesForUser(engineCore.inboxReceiptCursors, userId);
        } catch (error) {
          failures.push(error);
        }

        try {
          clearCacheEntriesForUser(engineCore.inboxMemberCounts, userId);
        } catch (error) {
          failures.push(error);
        }

        try {
          await rescheduleAlarm(engineCore);
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, `Inbox purge for '${userId}' was incomplete`);
      }
    });
  });
}

function tryDelete(operation: () => unknown, failures: unknown[]): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}
