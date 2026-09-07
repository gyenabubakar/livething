import { CloseCodes } from '@wskit/core';
import { isValidCloseCode } from '~/_engine/close-code.ts';
import type { ConnectionDescriptor } from './types.ts';

type NormalizeConnectionDescriptorOptionsParameter = {
  onInvalidCloseCode?: (code: unknown) => void;
};

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
  descriptor: ConnectionDescriptor,
  options: NormalizeConnectionDescriptorOptionsParameter = {},
): ConnectionDescriptor {
  return {
    send(data) {
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
    userId: descriptor.userId,
    meta: descriptor.meta,
    tags: descriptor.tags,
  };
}
