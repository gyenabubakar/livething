const MAGIC = [0x6c, 0x74, 0x62, 0x66]; // "ltbf"
const VERSION = 1;
const VERSION_OFFSET = 4;
const LENGTH_OFFSET = 5;

/** Magic (4 bytes), version (1 byte) and envelope length (uint32, big-endian). */
export const BINARY_HEADER_LENGTH = 9;
/** The largest envelope a binary frame can carry, in UTF-8 bytes. */
export const BINARY_ENVELOPE_LIMIT = 64 * 1024;

/** The bytes a caller may send in a binary frame. */
export type BinaryInput = Uint8Array | ArrayBuffer;

/** The result of splitting a received binary message. */
export type SplitBinaryFrame =
  | { kind: 'frame'; envelope: string; bytes: Uint8Array }
  | { kind: 'foreign' }
  | { kind: 'invalid'; reason: string };

// Created on first use: a platform without TextDecoder must still load @livething/core.
let decoder: InstanceType<typeof TextDecoder> | undefined;
let encoder: InstanceType<typeof TextEncoder> | undefined;

/**
 * A plain `Uint8Array` over the same memory, with no copy. A Node `Buffer` becomes a plain
 * view too, because `Buffer#slice` does not copy and handlers rely on `slice()` copying.
 */
export function asUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (!ArrayBuffer.isView(data)) return new Uint8Array(data);

  if (Object.getPrototypeOf(data) === Uint8Array.prototype) return data as Uint8Array;

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function hasMagic(frame: Uint8Array): boolean {
  if (frame.byteLength < MAGIC.length) return false;

  return MAGIC.every((value, index) => frame[index] === value);
}

/** Build one binary frame from envelope JSON text and the application's bytes. */
export function encodeBinaryFrame(envelope: string, bytes?: BinaryInput): Uint8Array<ArrayBuffer> {
  encoder ??= new TextEncoder();
  const envelopeBytes = encoder.encode(envelope);
  if (envelopeBytes.byteLength > BINARY_ENVELOPE_LIMIT) {
    throw new RangeError(
      `[livething] the binary frame's info and metadata are ${envelopeBytes.byteLength} bytes, over the 64 KiB limit. Put large data in the bytes.`,
    );
  }

  const body = bytes === undefined ? new Uint8Array(0) : asUint8Array(bytes);
  const frame = new Uint8Array(BINARY_HEADER_LENGTH + envelopeBytes.byteLength + body.byteLength);
  frame.set(MAGIC, 0);
  frame[VERSION_OFFSET] = VERSION;
  new DataView(frame.buffer).setUint32(LENGTH_OFFSET, envelopeBytes.byteLength, false);

  frame.set(envelopeBytes, BINARY_HEADER_LENGTH);
  frame.set(body, BINARY_HEADER_LENGTH + envelopeBytes.byteLength);

  return frame;
}

/**
 * Check the header and cut a received binary message into its envelope text and its bytes.
 * The bytes are a view of the frame, not a copy. The envelope is not parsed here: each side
 * parses it with the same code as a text frame.
 */
export function splitBinaryFrame(data: ArrayBuffer | ArrayBufferView): SplitBinaryFrame {
  const frame = asUint8Array(data);
  if (!hasMagic(frame)) return { kind: 'foreign' };

  if (frame.byteLength < BINARY_HEADER_LENGTH) {
    return { kind: 'invalid', reason: 'truncated header' };
  }

  const version = frame[VERSION_OFFSET];
  if (version !== VERSION) return { kind: 'invalid', reason: `unsupported version ${version}` };

  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    LENGTH_OFFSET,
    false,
  );
  if (length > BINARY_ENVELOPE_LIMIT) return { kind: 'invalid', reason: 'envelope is too large' };

  const bytesStart = BINARY_HEADER_LENGTH + length;
  if (bytesStart > frame.byteLength) {
    return { kind: 'invalid', reason: 'envelope goes past the frame end' };
  }

  decoder ??= new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let envelope: string;
  try {
    envelope = decoder.decode(frame.subarray(BINARY_HEADER_LENGTH, bytesStart));
  } catch {
    return { kind: 'invalid', reason: 'envelope is not UTF-8' };
  }

  return { kind: 'frame', envelope, bytes: frame.subarray(bytesStart) };
}
