import { CloseCodes, LiveThingConfigError } from '@livething/core';
import { MAX_TIMER_DELAY_MS } from '~/internal/config.ts';
import { createStore } from '~/internal/store.ts';
import { KeepaliveLoop } from '~/primitives/keepalive/loop.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { QualityThresholds } from '~/primitives/keepalive/loop.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Options for `keepalive()`. */
export interface KeepaliveOptions {
  /** How often to ping, in ms. Must be from 1 to `2 ** 31 - 1`, the longest a timer can hold. Default: `30_000`. */
  interval?: number;
  /** How many pongs can be missed before the socket is force-closed. Must be a whole number, 1 or more. Default: `2`. */
  maxMissedPongs?: number;
  /**
   * Latency cut-offs (ms) for the quality tiers. All three must be numbers, 0 or
   * more, with `excellent <= good <= degraded`. Default:
   * `{ excellent: 100, good: 300, degraded: 1000 }`, the same table the server uses.
   */
  thresholds?: QualityThresholds;
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

function areValidThresholds(thresholds: QualityThresholds): boolean {
  const cutOffs = [thresholds?.excellent, thresholds?.good, thresholds?.degraded];
  return (
    cutOffs.every((cutOff) => Number.isFinite(cutOff) && cutOff! >= 0) &&
    thresholds.excellent <= thresholds.good &&
    thresholds.good <= thresholds.degraded
  );
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
  const { interval, maxMissedPongs, thresholds } = options;
  if (
    interval !== undefined &&
    !(Number.isFinite(interval) && interval >= 1 && interval <= MAX_TIMER_DELAY_MS)
  ) {
    throw new LiveThingConfigError(
      `keepalive interval must be a number of ms from 1 to ${MAX_TIMER_DELAY_MS}, got ${interval}. ` +
        `To turn keepalive off, leave keepalive() out.`,
    );
  }

  if (maxMissedPongs !== undefined && !(Number.isInteger(maxMissedPongs) && maxMissedPongs >= 1)) {
    throw new LiveThingConfigError(
      `keepalive maxMissedPongs must be a whole number, 1 or more, got ${maxMissedPongs}.`,
    );
  }

  if (thresholds !== undefined && !areValidThresholds(thresholds)) {
    throw new LiveThingConfigError(
      `keepalive thresholds must be numbers of ms, 0 or more, with excellent <= good <= degraded, ` +
        `got ${JSON.stringify(thresholds)}.`,
    );
  }

  return {
    _tag: 'keepalive',
    setup(helpers) {
      const quality = createStore<ConnectionQuality>('disconnected', (error) =>
        helpers.log.report(error),
      );
      const latency = createStore<number | null>(null, (error) => helpers.log.report(error));

      const loop = new KeepaliveLoop(
        {
          interval,
          maxMissedPongs,
          thresholds,
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
