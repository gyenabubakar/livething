import type { QualityThresholds, SocketConfig } from '~/internal/config.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Keepalive-relevant subset of the config. */
export type KeepaliveConfig = Pick<
  SocketConfig,
  'pingInterval' | 'maxMissedPongs' | 'qualityThresholds'
>;

interface KeepaliveCallbacks {
  /** Send a `ping` frame to the server. */
  sendPing: () => void;
  /** Force-close the WebSocket after the missed-pong threshold. */
  forceClose: () => void;
  /** Notify the socket of a quality-tier change. */
  onQualityChange: (quality: ConnectionQuality, latency: number) => void;
}

/** Client-side quality thresholds (the server uses its own). */
const DEFAULT_THRESHOLDS: QualityThresholds = { excellent: 50, good: 150, degraded: 500 };

/**
 * Manages the keepalive ping/pong cycle, latency measurement, connection
 * quality tiers, and missed-pong detection.
 *
 * Internal class — not exported from the package. Used by Socket.
 */
export class Keepalive {
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private missedPongs = 0;
  private latency: number | null = null;
  private quality: ConnectionQuality = 'disconnected';

  private readonly interval: number;
  private readonly maxMissedPongs: number;
  private readonly thresholds: QualityThresholds;
  private readonly callbacks: KeepaliveCallbacks;

  constructor(config: KeepaliveConfig, callbacks: KeepaliveCallbacks) {
    this.interval = config.pingInterval ?? 30_000;
    this.maxMissedPongs = config.maxMissedPongs ?? 2;
    this.thresholds = config.qualityThresholds ?? DEFAULT_THRESHOLDS;
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
   * Called when a `pong` is received from the server. Measures round-trip
   * latency, resets the missed-pong counter, and recalculates the quality tier.
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
    this.callbacks.sendPing();
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
