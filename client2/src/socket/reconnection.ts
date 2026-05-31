import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveRuntime } from '~/internal/runtime.ts';

/** Reconnection-relevant subset of the config. */
export type ReconnectionConfig = Pick<
  SocketConfig,
  | 'reconnect'
  | 'maxReconnectAttempts'
  | 'maxReconnectDelay'
  | 'shouldReconnect'
  | 'nonRetryableCodes'
>;

/**
 * Manages reconnection with exponential backoff and jitter.
 *
 * Internal class — not exported from the package. Used by Socket to handle
 * automatic reconnection after drops.
 */
export class Reconnection {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  private readonly maxAttempts: number;
  private readonly maxDelay: number;
  private readonly nonRetryableCodes: Set<number>;
  private readonly config: ReconnectionConfig;
  private readonly primitives: readonly PrimitiveRuntime[];

  constructor(config: ReconnectionConfig, primitives: readonly PrimitiveRuntime[]) {
    this.config = config;
    this.primitives = primitives;
    this.maxAttempts = config.maxReconnectAttempts ?? 10;
    this.maxDelay = config.maxReconnectDelay ?? 30_000;
    this.nonRetryableCodes = new Set(config.nonRetryableCodes);
  }

  /**
   * Decide whether to reconnect after a close event.
   *
   * Decision chain (first definitive answer wins):
   * 1. Primitive `shouldReconnect` hooks (sorted order)
   * 2. User `shouldReconnect` callback
   * 3. `nonRetryableCodes` array
   * 4. Default: reconnect (unless `reconnect` is `false`)
   */
  shouldReconnect(code: number, reason: string): boolean {
    if (this.config.reconnect === false) return false;

    for (const primitive of this.primitives) {
      if (!primitive.shouldReconnect) continue;
      const result = primitive.shouldReconnect(code, reason);
      if (result === true) return true;
      if (result === false) return false;
    }

    if (this.config.shouldReconnect) {
      const result = this.config.shouldReconnect(code, reason);
      if (result === true) return true;
      if (result === false) return false;
    }

    if (this.nonRetryableCodes.has(code)) return false;

    return true;
  }

  /**
   * Schedule a reconnection attempt. Calls `onReconnect` after the backoff
   * delay. Returns `false` if max attempts exceeded.
   */
  schedule(onReconnect: () => void, onExhausted: () => void): boolean {
    if (this.attempt >= this.maxAttempts) {
      onExhausted();
      return false;
    }

    if (this.paused) return true;

    const delay = this.calculateDelay();
    this.attempt++;

    this.timer = setTimeout(() => {
      this.timer = null;
      onReconnect();
    }, delay);

    return true;
  }

  /** Reset backoff after a successful connection. */
  reset(): void {
    this.attempt = 0;
    this.clearTimer();
  }

  /** Stop all reconnection — called by disconnect(). */
  stop(): void {
    this.attempt = 0;
    this.paused = false;
    this.clearTimer();
  }

  /** Pause reconnection (e.g., device went offline). */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume reconnection (e.g., device came back online). Resets backoff to 1s. */
  resume(onReconnect: () => void, onExhausted: () => void): void {
    if (!this.paused) return;
    this.paused = false;
    this.attempt = 0;
    this.schedule(onReconnect, onExhausted);
  }

  /** Current attempt number (0-based). */
  get currentAttempt(): number {
    return this.attempt;
  }

  /** Whether reconnection is currently paused. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Calculate delay with exponential backoff and jitter.
   *
   * Base delay doubles each attempt: 1s, 2s, 4s, 8s, 16s, capped at maxDelay.
   * Jitter adds ±30% variation to prevent thundering herd.
   */
  private calculateDelay(): number {
    const baseDelay = Math.min(1000 * Math.pow(2, this.attempt), this.maxDelay);
    const jitter = baseDelay * 0.3;
    return baseDelay - jitter + Math.random() * jitter * 2;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
