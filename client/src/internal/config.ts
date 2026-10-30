import type { InterceptFn, Message } from '~/internal/runtime.ts';

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
  idleTimeout?: number;
  /** WebSocket subprotocols. */
  protocols?: string[];

  /** Format the server delivers binary frames in. */
  binaryType?: 'arraybuffer' | 'blob';
  /** Decode a binary frame into a message, or `null` to ignore it. */
  parseBinary?: (data: unknown) => Message | null;

  /** Functions that get to inspect/transform/drop each incoming message. */
  intercepts?: InterceptFn[];
}
