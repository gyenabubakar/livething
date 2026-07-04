import { clearInboxForChannel, drainInboxOnReconnect, fanOutToInbox } from '~/inbox/runtime.ts';
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
  });
}
