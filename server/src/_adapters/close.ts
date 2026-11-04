import { CloseCodes, utf8ByteLength } from '@livething/core';
import { isValidCloseCode } from '~/_engine/close-code.ts';
import type { SocketDescriptor } from './types.ts';

type NormalizeConnectionDescriptorOptionsParameter = {
  onInvalidCloseCode?: (code: unknown) => void;
  /** Refuse to send a message bigger than this many bytes. */
  sendBytes?: number;
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

/** Apply the shared close-reason rule to an accepted connection descriptor. */
export function normalizeConnectionDescriptor(
  descriptor: SocketDescriptor,
  options: NormalizeConnectionDescriptorOptionsParameter = {},
): SocketDescriptor {
  const { sendBytes } = options;
  return {
    send(data) {
      // The platform could drop a bigger message with no error (Cloudflare does), so refuse it.
      if (sendBytes !== undefined && textOverLimit(data, sendBytes)) {
        throw new Error(
          `[livething] A message of ${utf8ByteLength(data)} bytes is over the send limit of ${sendBytes} bytes.`,
        );
      }

      return descriptor.send(data);
    },
    close(code, reason) {
      const closeCode = code ?? CloseCodes.NORMAL;
      if (!isValidCloseCode(closeCode)) {
        options.onInvalidCloseCode?.(code);
        descriptor.close(CloseCodes.INTERNAL_ERROR, 'Internal error');
        return;
      }

      descriptor.close(closeCode, normalizeCloseReason(reason));
    },
    bufferedAmount() {
      return descriptor.bufferedAmount();
    },
    backpressureSupported: descriptor.backpressureSupported,
  };
}
