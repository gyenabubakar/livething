import { rescheduleAlarm } from '~/_engine/alarm.ts';
import { clearCacheEntriesForUser, purgeReceiptsByUser } from '~/inbox/receipts-storage.ts';
import { clearInboxForChannel, drainInboxOnReconnect, fanOutToInbox } from '~/inbox/runtime.ts';
import { deleteInboxRowsOutsideScopes, purgeInboxByUser } from '~/inbox/storage.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { InboxService } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

/**
 * The inbox fan-out / drain / clear runtime, reached through the engine's
 * `inboxService` slot. Registered once by the `inbox()` capability even when
 * several channels enable inbox — a handler that lists none ships none of this.
 */
export const inboxService: InboxService = {
  fanOut(core: EngineCore, opts) {
    fanOutToInbox(core, opts);
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

    engine.onPurgeUser((core, userId) => {
      const engineCore = core as EngineCore;
      purgeInboxByUser(engineCore.storage.sql, userId);
      purgeReceiptsByUser(engineCore.storage.sql, userId);
      clearCacheEntriesForUser(engineCore.inboxReceiptCursors, userId);
      clearCacheEntriesForUser(engineCore.inboxMemberCounts, userId);
      rescheduleAlarm(engineCore);
    });
  });
}
