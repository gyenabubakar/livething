import { buildReadReceiptsSurface } from '~/inbox/read-receipts-surface.ts';
import type { EngineAccess } from '~/_engine/access.ts';

const READ_RECEIPTS_AUGMENTER_KEY = Symbol('read-receipts-handle-augmenter');

/**
 * Register the channel-handle augmenter that grafts `handle.readReceipts()` onto
 * every channel handle. It returns the channel's read-receipts surface when that
 * channel opted into `readReceipts()`, or `null` otherwise. Installed once even
 * when several channels enable read receipts.
 */
export function registerReadReceiptsHandleAugmenter(engine: EngineAccess): void {
  engine.installOnce(READ_RECEIPTS_AUGMENTER_KEY, () => {
    engine.addChannelHandleAugmenter((handle, scope) => {
      const channelKey = scope.channelFamily ?? scope.channelName;
      handle.readReceipts = () =>
        engine.hasReadReceiptsChannel(channelKey) ? buildReadReceiptsSurface(engine, scope) : null;
    });
  });
}
