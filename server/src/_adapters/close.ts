import { CloseCodes, utf8ByteLength } from '@livething/core';
import { isValidCloseCode } from '~/_engine/close-code.ts';
import type { SocketDescriptor, TransportFrame } from './types.ts';

type NormalizeConnectionDescriptorOptionsParameter = {
  onInvalidCloseCode?: (code: unknown) => void;
  /** Refuse to send a message bigger than this many bytes. */
  sendBytes?: number;
  /** Runs just before the descriptor closes a client that reads too slowly. */
  onTooSlow?: () => void;
};

/**
 * Whether a text message is over a byte limit. A UTF-16 unit is at most 3 UTF-8 bytes, so a
 * short message skips the exact count.
 */
export function textOverLimit(text: string, limit: number): boolean {
  return text.length * 3 > limit && utf8ByteLength(text) > limit;
}

const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Keep a WebSocket close reason within the protocol's 123-byte UTF-8 limit.
 * The engine applies this automatically to accepted connection descriptors.
 * Adapters can use it for transport-owned closes outside the engine, such as
 * rejecting an upgrade before a connection is accepted.
 */
export function normalizeCloseReason(reason?: string): string | undefined {
  if (reason === undefined) return undefined;

  const encoder = new TextEncoder();
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) return reason;

  let bytes = 0;
  let limited = '';
  for (const character of reason) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > MAX_CLOSE_REASON_BYTES) break;

    limited += character;
    bytes += characterBytes;
  }

  return limited;
}

function frameOverLimit(frame: TransportFrame, limit: number): boolean {
  if (frame.kind === 'bytes') return frame.bytes.byteLength > limit;

  return textOverLimit(frame.text, limit);
}

function frameBytes(frame: TransportFrame): number {
  return frame.kind === 'bytes' ? frame.bytes.byteLength : utf8ByteLength(frame.text);
}

/** How long a client closed for reading too slowly has to read the close frame. */
const TERMINATE_AFTER_MS = 1000;

/** How long a socket's buffer may stay over twice `sendBytes` before its client counts as slow. */
const SLOW_CLIENT_GRACE_MS = 10_000;

/**
 * Tell when a socket's client reads too slowly: its buffer has stayed over twice `sendBytes` for
 * longer than the grace time. A big burst (a replay catch-up) takes time to leave the buffer even
 * for a client that reads at full speed, so one look at the buffer is not enough.
 */
function watchBacklog(descriptor: SocketDescriptor, sendBytes: number | undefined) {
  const watching = sendBytes !== undefined && descriptor.backpressureSupported === true;
  let overSince: number | undefined;

  return function tooSlow(): boolean {
    if (!watching) return false;

    if (descriptor.bufferedAmount() <= 2 * sendBytes!) {
      overSince = undefined;
      return false;
    }

    // A monotonic clock: a step of the system clock (NTP, sleep) must not look like 10 seconds.
    const now = performance.now();
    overSince ??= now;

    return now - overSince > SLOW_CLIENT_GRACE_MS;
  };
}

/**
 * Apply the shared close-reason rule, the send limit and the slow-member close to an
 * accepted connection descriptor.
 */
export function normalizeConnectionDescriptor(
  descriptor: SocketDescriptor,
  options: NormalizeConnectionDescriptorOptionsParameter = {},
): SocketDescriptor {
  const { sendBytes } = options;
  let closed = false;

  function close(code?: number, reason?: string): void {
    closed = true;
    const closeCode = code ?? CloseCodes.NORMAL;
    if (!isValidCloseCode(closeCode)) {
      options.onInvalidCloseCode?.(code);
      descriptor.close(CloseCodes.INTERNAL_ERROR, 'Internal error');
      return;
    }

    descriptor.close(closeCode, normalizeCloseReason(reason));
  }

  const tooSlow = watchBacklog(descriptor, sendBytes);

  function closeTooSlow(): void {
    options.onTooSlow?.();
    close(CloseCodes.TRY_AGAIN_LATER, '[livething] the client reads too slowly');
    if (!descriptor.terminate) return;

    // The close frame waits behind the unsent data, so a client that reads nothing never gets it.
    const timer = setTimeout(() => descriptor.terminate?.(), TERMINATE_AFTER_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    send(frame) {
      // The platform could drop a bigger message with no error (Cloudflare does), so refuse it.
      if (sendBytes !== undefined && frameOverLimit(frame, sendBytes)) {
        throw new Error(
          `[livething] A message of ${frameBytes(frame)} bytes is over the send limit of ${sendBytes} bytes.`,
        );
      }

      if (tooSlow()) {
        if (!closed) closeTooSlow();
        return false;
      }

      return descriptor.send(frame);
    },
    close,
    bufferedAmount() {
      return descriptor.bufferedAmount();
    },
    backpressureSupported: descriptor.backpressureSupported,
  };
}
