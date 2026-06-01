import { CloseCodes } from '@wskit/core';
import { KeepaliveLoop } from '~/primitives/keepalive/loop.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `keepalive()`. */
export interface KeepaliveOptions {
  /** How often to ping, in ms. `0` turns it off. Default: `30_000`. */
  interval?: number;
  /** How many pongs can be missed before the socket is force-closed. Default: `2`. */
  maxMissedPongs?: number;
}

/**
 * Adds client pings so a quiet connection isn't dropped by proxies, measures
 * latency to drive quality, and closes a connection that stops answering. It's
 * opt-in: without it the client still replies to the server's pings (the engine
 * does that), but sends none of its own. Its code ships only when you add it.
 */
export function keepalive(options: KeepaliveOptions = {}): Primitive<EmptyTypeFn> {
  return {
    _tag: 'keepalive',
    setup(helpers) {
      const loop = new KeepaliveLoop(
        {
          interval: options.interval,
          maxMissedPongs: options.maxMissedPongs,
          thresholds: helpers.config.qualityThresholds,
        },
        {
          sendPing: () => helpers.rawSend({ event: 'ping', payload: {} }),
          forceClose: () => helpers.forceClose(CloseCodes.IDLE, 'missed pong'),
          onQualityChange: (quality, latency) => helpers.reportQuality(quality, latency),
        },
      );

      helpers.onPong(() => loop.onPong());

      return {
        id: 'keepalive',
        onOpen() {
          loop.start();
          return null;
        },
        onClose() {
          loop.stop();
        },
      };
    },
  };
}
