/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin array typing */
import type { Plugin } from '@/plugins/base.ts';

/** Options that control reconnection behavior. */
export interface ReconnectionOptions {
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  maxReconnectDelay?: number;
  shouldReconnect?: (code: number, reason: string) => boolean | void;
  nonRetryableCodes?: number[];
}

/**
 * Manages reconnection with exponential backoff and jitter.
 *
 * Internal module — not exported from the package. Used by Socket to
 * handle automatic reconnection after connection drops.
 */
export class Reconnection {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  private readonly maxAttempts: number;
  private readonly maxDelay: number;
  private readonly options: ReconnectionOptions;
  private readonly plugins: readonly Plugin<any, any>[];

  constructor(options: ReconnectionOptions, plugins: readonly Plugin<any, any>[]) {
    this.options = options;
    this.plugins = plugins;
    this.maxAttempts = options.maxReconnectAttempts ?? 10;
    this.maxDelay = options.maxReconnectDelay ?? 30_000;
  }

  /**
   * Decide whether to reconnect after a close event.
   *
   * Decision chain (first definitive answer wins):
   * 1. Plugin shouldReconnect hooks (array order)
   * 2. Socket-level shouldReconnect callback
   * 3. nonRetryableCodes array
   * 4. Default: reconnect (if reconnect option is not false)
   */
  shouldReconnect(code: number, reason: string): boolean {
    if (this.options.reconnect === false) return false;

    // 1. Plugin hooks — first true/false wins
    for (const plugin of this.plugins) {
      if (!plugin.shouldReconnect) continue;
      const result = plugin.shouldReconnect(code, reason);
      if (result === true) return true;
      if (result === false) return false;
    }

    // 2. Socket-level callback
    if (this.options.shouldReconnect) {
      const result = this.options.shouldReconnect(code, reason);
      if (result === true) return true;
      if (result === false) return false;
    }

    // 3. Non-retryable codes
    if (this.options.nonRetryableCodes?.includes(code)) return false;

    // 4. Default: reconnect
    return true;
  }

  /**
   * Schedule a reconnection attempt. Calls `onReconnect` after the
   * backoff delay. Returns `false` if max attempts exceeded.
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
