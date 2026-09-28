import { CloseCodes } from '@livething/core';
import { createStore } from '~/internal/store.ts';
import { KeepaliveLoop } from '~/primitives/keepalive/loop.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Options for `keepalive()`. */
export interface KeepaliveOptions {
  /** How often to ping, in ms. `0` turns it off. Default: `30_000`. */
  interval?: number;
  /** How many pongs can be missed before the socket is force-closed. Default: `2`. */
  maxMissedPongs?: number;
}

/** The connection-health stores that `keepalive()` adds to the socket. */
export interface QualityApi {
  /**
   * Connection quality as a reactive store — `quality.get()` reads the current
   * tier, `quality.subscribe(listener)` runs whenever the tier changes. It stays
   * `'disconnected'` until the first pong measures a real value. A missed pong sets
   * it to `'poor'`, and it returns to `'disconnected'` when the socket closes
   * (including the force-close after `maxMissedPongs` missed pongs).
   */
  quality: ReadableStore<ConnectionQuality>;

  /**
   * Round-trip latency in ms as a reactive store — `latency.get()` reads the last
   * measurement, `latency.subscribe(listener)` runs on every pong. It's `null`
   * before the first pong and again once the connection isn't being measured.
   */
  latency: ReadableStore<number | null>;
}

interface KeepaliveTypeFn extends TypeFn {
  readonly _api: QualityApi;
}

/**
 * Adds client pings so a quiet connection isn't dropped by proxies, tracks
 * round-trip latency to report connection quality, and closes a connection
 * that stops answering. It's opt-in: without it the socket still replies to
 * the server's pings automatically, but sends none of its own.
 *
 * The `quality` and `latency` stores only mean anything once something measures
 * pongs, so they live here — added to the socket only when you install
 * `keepalive()`.
 */
export function keepalive(options: KeepaliveOptions = {}): Primitive<KeepaliveTypeFn> {
  return {
    _tag: 'keepalive',
    setup(helpers) {
      const quality = createStore<ConnectionQuality>('disconnected', (error) =>
        helpers.log.report(error),
      );
      const latency = createStore<number | null>(null, (error) => helpers.log.report(error));

      const loop = new KeepaliveLoop(
        {
          interval: options.interval,
          maxMissedPongs: options.maxMissedPongs,
          thresholds: helpers.config.qualityThresholds,
        },
        {
          sendPing: () => helpers.sendPing(),
          forceClose: () => helpers.forceClose(CloseCodes.IDLE, 'missed pong'),
          reportLatency: (latencyMs) => latency.set(latencyMs),
          onQualityChange: (next) => quality.set(next),
          log: (message) => helpers.log.info(message),
        },
      );

      helpers.onPong(() => loop.onPong());

      return {
        id: 'keepalive',

        install(socket) {
          // @ts-expect-error — install adds the quality/latency stores to the socket dynamically
          socket.quality = quality.store;
          // @ts-expect-error — same
          socket.latency = latency.store;
        },

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

keepalive.tag = 'keepalive';
