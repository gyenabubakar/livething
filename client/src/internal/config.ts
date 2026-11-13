import { LiveThingConfigError } from '@livething/core';
import type { InterceptFn } from '~/internal/runtime.ts';

/** The longest delay a timer can hold. Above this, `setTimeout` and `setInterval` fire after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Refuse a message time-to-live that would drop every queued message, such as `NaN`. */
export function assertValidTtl(ttl: number, owner: string): void {
  if (!(Number.isFinite(ttl) && ttl >= 0)) {
    throw new LiveThingConfigError(
      `${owner} ttl must be a finite number of ms, 0 or more (0 means it never expires), got ${ttl}.`,
    );
  }
}

/** The config error for a delay a timer can't hold, or `null` when the delay is fine. */
export function timerDelayError(delay: number, option: string): LiveThingConfigError | null {
  if (Number.isFinite(delay) && delay >= 1 && delay <= MAX_TIMER_DELAY_MS) return null;

  return new LiveThingConfigError(
    `${option} must be a number of ms from 1 to ${MAX_TIMER_DELAY_MS}, got ${delay}.`,
  );
}

/**
 * The settings the kernel runs on. It only holds kernel-level things. Anything
 * specific to one behavior — backoff, ping interval, buffer size — lives inside
 * that primitive, not here, so its code only loads when you use it.
 */
export interface SocketConfig {
  /** The URL, or a function that returns one on every connect/reconnect. */
  url: string | (() => string | Promise<string>);
  /** Wait to connect until something needs the socket. */
  lazy?: boolean;
  /** In lazy mode, close after this many ms of no use. `0` means never. Default: 10_000. */
  lazyIdleTimeoutMs?: number;
  /** WebSocket subprotocols. */
  protocols?: string[];
  /** Returns the login token on every connect/reconnect. */
  token?: () => string | null | undefined | Promise<string | null | undefined>;

  /** Functions that get to inspect/transform/drop each incoming message. */
  intercepts?: InterceptFn[];
}
