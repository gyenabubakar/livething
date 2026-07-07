import { buildInboxSurface } from '~/inbox/surface.ts';
import type { EngineAccess } from '~/_engine/access.ts';

const INBOX_AUGMENTER_KEY = Symbol('inbox-handle-augmenter');

/**
 * Register the channel-handle augmenter that grafts `handle.inbox()` onto every
 * channel handle. It returns the channel's inbox surface when that channel has
 * `inbox()` enabled, or `null` otherwise — so `ctx.channels.get(name).inbox()`
 * reaches the same backfill / receiversOf / backlog ops as the owning scope.
 * Installed once even when several channels enable inbox.
 */
export function registerInboxHandleAugmenter(engine: EngineAccess): void {
  engine.installOnce(INBOX_AUGMENTER_KEY, () => {
    engine.addChannelHandleAugmenter((handle, scope) => {
      const channelKey = scope.channelFamily ?? scope.channelName;
      handle.inbox = () =>
        engine.getInboxChannel(channelKey) ? buildInboxSurface(engine, scope) : null;
    });
  });
}
