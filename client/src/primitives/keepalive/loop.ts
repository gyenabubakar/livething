import type { QualityThresholds } from '~/internal/config.ts';
import type { ConnectionQuality } from '~/types.ts';

/** Settings for the ping loop. */
export interface KeepaliveLoopOptions {
  interval?: number;
  maxMissedPongs?: number;
  thresholds?: QualityThresholds;
}

/** The few things the loop asks the socket helpers to do. */
interface KeepaliveCallbacks {
  sendPing: () => void;
  forceClose: () => void;
  /** Report the latest single round-trip time so `getLatency()` stays fresh every pong.
   * `null` clears it — used when a pong goes missing and the last RTT is stale. */
  reportLatency: (latencyMs: number | null) => void;
  /** Report a new quality tier (fired only when the tier actually changes). */
  onQualityChange: (quality: ConnectionQuality) => void;
  log: (message: string) => void;
}

/** How many recent samples the quality tier is averaged over, to smooth out spikes. */
const QUALITY_WINDOW = 5;

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
  private samples: number[] = [];
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
    // No initial quality guess — the socket stays at the default until the first
    // pong arrives and fires a qualityChange with a real measurement.

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
    this.samples = [];
    // Clear the stale round-trip time first, then route the tier through
    // setQuality, so the final 'disconnected' change reaches event-only listeners
    // with null latency, not the last live value. setQuality dedupes, so start()'s
    // initial stop() (already 'disconnected') and repeated stops don't fire.
    this.callbacks.reportLatency(null);
    this.setQuality('disconnected');
  }

  /** Call when a pong arrives: record the round-trip time and refresh quality. */
  onPong(): void {
    if (this.pingSentAt === null) return;

    const latency = Date.now() - this.pingSentAt;
    this.pingSentAt = null;
    this.missedPongs = 0;
    this.recordSample(latency);
    // reportLatency reflects the latest single ping; the quality tier uses the
    // rolling average so one slow pong doesn't flip the indicator.
    this.callbacks.reportLatency(latency);
    this.setQuality(this.qualityFromLatency(this.averageLatency()));
  }

  private tick(): void {
    if (this.pingSentAt !== null) {
      this.missedPongs++;
      this.callbacks.log(`missed pong ${this.missedPongs}/${this.maxMissedPongs}`);
      if (this.missedPongs >= this.maxMissedPongs) {
        this.callbacks.log('connection looks dead — force closing');
        this.stop();
        this.callbacks.forceClose();
        return;
      }

      // The last measured RTT is stale once a pong goes unanswered — clear it so
      // the 'poor' change (and getLatency()) report null, not a healthy-looking value.
      this.callbacks.reportLatency(null);
      this.setQuality('poor');
    }

    this.pingSentAt = Date.now();
    this.callbacks.sendPing();
  }

  /** Keep at most the last `QUALITY_WINDOW` samples (a moving window). */
  private recordSample(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > QUALITY_WINDOW) this.samples.shift();
  }

  /** Average of the samples collected so far (fewer than the full window early on). */
  private averageLatency(): number {
    const total = this.samples.reduce((sum, ms) => sum + ms, 0);
    return total / this.samples.length;
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
    this.callbacks.onQualityChange(next);
  }
}
