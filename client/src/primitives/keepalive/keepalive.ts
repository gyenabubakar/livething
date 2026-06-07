import { CloseCodes } from '@wskit/core';
import { KeepaliveLoop } from '~/primitives/keepalive/loop.ts';
import type { Primitive, TypeFn } from '~/primitives/types.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Options for `keepalive()`. */
export interface KeepaliveOptions {
  /** How often to ping, in ms. `0` turns it off. Default: `30_000`. */
  interval?: number;
  /** How many pongs can be missed before the socket is force-closed. Default: `2`. */
  maxMissedPongs?: number;
}

/** The connection-quality API that `keepalive()` adds to the socket. */
export interface QualityApi {
  /** The current connection quality. `'disconnected'` while not open, the optimistic default until the first pong. */
  getQuality(): ConnectionQuality;
  /** The last round-trip time in ms, or `null` if not measured yet. */
  getLatency(): number | null;
  /** Runs when the quality tier changes. */
  onQualityChange(callback: (quality: ConnectionQuality, latency: number) => void): () => void;
}

interface KeepaliveTypeFn extends TypeFn {
  readonly _api: QualityApi;
}

/**
 * Adds client pings so a quiet connection isn't dropped by proxies, tracks
 * round-trip latency to report connection quality, and closes a connection
 * that stops answering. It's opt-in: without it the client still replies to
 * the server's pings (the engine handles that), but sends none of its own.
 *
 * Because the quality getters (`getQuality`/`getLatency`/`onQualityChange`) only
 * mean anything once something measures pongs, they live here — they're added to
 * the socket only when you install `keepalive()`.
 */
export function keepalive(options: KeepaliveOptions = {}): Primitive<KeepaliveTypeFn> {
  return {
    _tag: 'keepalive',
    setup(helpers) {
      // The latest measurements. `quality` stays null until the first pong, so
      // getQuality() can return the optimistic default until then.
      let quality: ConnectionQuality | null = null;
      let latency: number | null = null;
      const listeners = new Set<(quality: ConnectionQuality, latency: number) => void>();

      const loop = new KeepaliveLoop(
        {
          interval: options.interval,
          maxMissedPongs: options.maxMissedPongs,
          thresholds: helpers.config.qualityThresholds,
        },
        {
          sendPing: () => helpers.sendPing(),
          forceClose: () => helpers.forceClose(CloseCodes.IDLE, 'missed pong'),
          reportLatency: (latencyMs) => {
            latency = latencyMs;
          },
          // The loop fires this only when the tier actually changes.
          onQualityChange: (next) => {
            quality = next;
            for (const listener of [...listeners]) listener(next, latency ?? 0);
          },
          log: (message) => helpers.log.info(message),
        },
      );

      helpers.onPong(() => loop.onPong());

      return {
        id: 'keepalive',
        install(socket) {
          // @ts-expect-error — install adds the quality API to the socket dynamically
          socket.getQuality = (): ConnectionQuality =>
            helpers.getState() !== 'open' ? 'disconnected' : (quality ?? 'excellent');
          // @ts-expect-error — same
          socket.getLatency = (): number | null => latency;
          // @ts-expect-error — same
          socket.onQualityChange = (callback): (() => void) => {
            listeners.add(callback);
            return () => {
              listeners.delete(callback);
            };
          };
        },
        onOpen() {
          loop.start();
          return null;
        },
        onClose() {
          loop.stop();
          quality = null;
          latency = null;
        },
      };
    },
  };
}
