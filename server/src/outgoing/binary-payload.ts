import { asUint8Array } from '@livething/core';
import type { BinaryInput } from '@livething/core';

/*
 * A leaf module, so a feature's `capability.ts` (streams, requests) can wrap a binary payload
 * without importing the outgoing engine in `runtime.ts`.
 */

const BINARY_PAYLOAD = Symbol('livething.binary-payload');
const NO_BYTES = new Uint8Array(0);

/**
 * The info and the bytes of a binary send. The `.binary` senders hand it to the JSON send
 * methods in the payload's place, so a binary send takes the same path to the same audience.
 */
export interface BinaryPayload {
  readonly [BINARY_PAYLOAD]: true;
  readonly info: unknown;
  readonly bytes: Uint8Array;
}

/** Wrap a binary send's info and bytes so the send path writes a binary frame. */
export function binaryPayload(info: unknown, bytes?: BinaryInput): BinaryPayload {
  if (
    bytes !== undefined &&
    !ArrayBuffer.isView(bytes) &&
    Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]'
  ) {
    throw new TypeError(
      `[livething] The bytes of a binary send must be a Uint8Array or an ArrayBuffer, got ${typeof bytes}.`,
    );
  }

  return {
    [BINARY_PAYLOAD]: true,
    info,
    bytes: bytes === undefined ? NO_BYTES : asUint8Array(bytes),
  };
}

/**
 * The binary payload of a value a handler gave as `{ info, bytes }`: a binary request's reply
 * (`bytes` optional) or a binary stream's chunk (`bytes` required). Plain JavaScript can give
 * anything, so a bad value throws an error that names the handler, as `method` gives it.
 */
export function binaryPayloadOf(
  method: string,
  value: unknown,
  bytesRequired: boolean,
): BinaryPayload {
  const given = value as { info?: unknown; bytes?: BinaryInput } | null | undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('info' in value) ||
    (bytesRequired && given?.bytes === undefined)
  ) {
    const shape = bytesRequired ? '{ info, bytes }' : '{ info, bytes? }';
    throw new TypeError(
      `[livething] ${method} must give ${shape}, got ${value === null ? 'null' : typeof value}.`,
    );
  }

  try {
    return binaryPayload(given!.info, given!.bytes);
  } catch (error) {
    throw new TypeError(
      `[livething] ${method}: ${(error as Error).message.replace('[livething] ', '')}`,
    );
  }
}

/** Whether a payload is the info and bytes of a binary send, made by `binaryPayload`. */
export function isBinaryPayload(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && BINARY_PAYLOAD in payload;
}
