import type { QualityThresholds } from '~/internal/config.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Settings for the ping loop. */
export interface KeepaliveLoopOptions {
  interval?: number;
  maxMissedPongs?: number;
  thresholds?: QualityThresholds;
}

/** The few things the loop asks the engine to do. */
interface KeepaliveCallbacks {
  sendPing: () => void;
  forceClose: () => void;
  onQualityChange: (quality: ConnectionQuality, latency: number) => void;
}

/** Default latency cut-offs. The server measures quality on its own side. */
const DEFAULT_THRESHOLDS: QualityThresholds = { excellent: 50, good: 150, degraded: 500 };

/**
 * Sends pings on a timer and watches for the matching pongs. Each pong gives a
 * round-trip time, which sets the quality tier. If too many pongs go missing the
 * connection is treated as dead and force-closed.
 */
export class KeepaliveLoop {
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private missedPongs = 0;
  private latency: number | null = null;
  private quality: ConnectionQuality = 'disconnected';

  private readonly interval: number;
  private readonly maxMissedPongs: number;
  private readonly thresholds: QualityThresholds;
  private readonly callbacks: KeepaliveCallbacks;

  constructor(options: KeepaliveLoopOptions, callbacks: KeepaliveCallbacks) {
    this.interval = options.interval ?? 30_000;
    this.maxMissedPongs = options.maxMissedPongs ?? 2;
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.callbacks = callbacks;
  }

  /** Begin pinging. Call once the socket is open. */
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

  /** Stop pinging and reset. Call on close. */
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

  /** Call when a pong arrives: record the round-trip time and refresh quality. */
  onPong(): void {
    if (this.pingSentAt === null) return;

    this.latency = Date.now() - this.pingSentAt;
    this.pingSentAt = null;
    this.missedPongs = 0;
    this.setQuality(this.qualityFromLatency(this.latency));
  }

  getQuality(): ConnectionQuality {
    return this.quality;
  }

  getLatency(): number | null {
    return this.latency;
  }

  private tick(): void {
    // If the previous ping was never answered, count it as missed.
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
