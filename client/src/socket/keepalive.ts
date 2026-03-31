import type { SocketOptions } from '~/options.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Keepalive-relevant subset of SocketOptions. */
export type KeepaliveOptions = Pick<
  SocketOptions,
  'pingInterval' | 'pingMessage' | 'pongMessage' | 'maxMissedPongs' | 'qualityThresholds'
>;

interface KeepaliveCallbacks {
  sendPing: (message: string) => void;
  forceClose: () => void;
  onQualityChange: (quality: ConnectionQuality, latency: number) => void;
}

const DEFAULT_THRESHOLDS = { excellent: 100, good: 300, degraded: 1000 };

/**
 * Manages the keepalive ping/pong cycle, latency measurement,
 * connection quality tiers, and missed pong detection.
 *
 * Internal module — not exported from the package. Used by Socket.
 */
export class Keepalive {
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private missedPongs = 0;
  private latency: number | null = null;
  private quality: ConnectionQuality = 'disconnected';

  private readonly interval: number;
  private readonly pingMessage: string;
  private readonly maxMissedPongs: number;
  private readonly thresholds: { excellent: number; good: number; degraded: number };
  private readonly callbacks: KeepaliveCallbacks;

  constructor(options: KeepaliveOptions, callbacks: KeepaliveCallbacks) {
    this.interval = options.pingInterval ?? 30_000;
    this.pingMessage = options.pingMessage ?? 'ping';
    this.maxMissedPongs = options.maxMissedPongs ?? 2;
    this.thresholds = options.qualityThresholds ?? DEFAULT_THRESHOLDS;
    this.callbacks = callbacks;
  }

  /** Start the ping cycle. Call after the WebSocket is open. */
  start(): void {
    this.stop();
    if (this.interval <= 0) return;

    this.missedPongs = 0;
    this.pingSentAt = null;
    this.setQuality('excellent');

    this.pingTimer = setInterval(() => {
      this.tick();
    }, this.interval);
  }

  /** Stop the ping cycle. Call on disconnect or close. */
  stop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pingSentAt = null;
    this.missedPongs = 0;
    this.latency = null;
    this.quality = 'disconnected';
  }

  /**
   * Called when a pong message is received from the server. Measures the
   * round-trip latency, resets the missed pong counter, and recalculates
   * the connection quality tier.
   */
  onPong(): void {
    if (this.pingSentAt === null) return;

    this.latency = Date.now() - this.pingSentAt;
    this.pingSentAt = null;
    this.missedPongs = 0;
    this.setQuality(this.qualityFromLatency(this.latency));
  }

  /** Current connection quality tier. */
  getQuality(): ConnectionQuality {
    return this.quality;
  }

  /** Last measured round-trip latency in ms, or `null` if unknown. */
  getLatency(): number | null {
    return this.latency;
  }

  private tick(): void {
    if (this.pingSentAt !== null) {
      this.missedPongs++;

      if (this.missedPongs >= this.maxMissedPongs) {
        this.callbacks.forceClose();
        return;
      }

      this.setQuality('poor');
    }

    this.pingSentAt = Date.now();
    this.callbacks.sendPing(this.pingMessage);
  }

  private qualityFromLatency(latency: number): ConnectionQuality {
    if (latency < this.thresholds.excellent) return 'excellent';
    if (latency < this.thresholds.good) return 'good';
    if (latency < this.thresholds.degraded) return 'degraded';
    return 'poor';
  }

  private setQuality(next: ConnectionQuality): void {
    if (this.quality === next) return;
    this.quality = next;
    this.callbacks.onQualityChange(next, this.latency ?? 0);
  }
}
