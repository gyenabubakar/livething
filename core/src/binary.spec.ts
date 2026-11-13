import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  asUint8Array,
  BINARY_ENVELOPE_LIMIT,
  BINARY_HEADER_LENGTH,
  encodeBinaryFrame,
  splitBinaryFrame,
} from './binary.ts';

const MAGIC = [0x6c, 0x74, 0x62, 0x66];

function withEnvelopeBytes(envelope: Uint8Array, bytes: number[] = []): Uint8Array {
  const frame = new Uint8Array(BINARY_HEADER_LENGTH + envelope.byteLength + bytes.length);
  frame.set(MAGIC, 0);
  frame[4] = 1;
  new DataView(frame.buffer).setUint32(5, envelope.byteLength, false);
  frame.set(envelope, BINARY_HEADER_LENGTH);

  frame.set(bytes, BINARY_HEADER_LENGTH + envelope.byteLength);

  return frame;
}

const picture = new Uint8Array([137, 80, 78, 71]);
const envelope = '["screen-frame",{"from":"u_amara"},{"channel":{"name":"room:general"}}]';

describe('encodeBinaryFrame', () => {
  it('writes the magic, the version, the envelope length, the envelope and the bytes', () => {
    const frame = encodeBinaryFrame(envelope, picture);
    const length = new TextEncoder().encode(envelope).byteLength;

    expect([...frame.subarray(0, 4)]).toEqual(MAGIC);
    expect(frame[4]).toBe(1);
    expect(new DataView(frame.buffer).getUint32(5, false)).toBe(length);
    expect(new TextDecoder().decode(frame.subarray(9, 9 + length))).toBe(envelope);
    expect([...frame.subarray(9 + length)]).toEqual([...picture]);
  });

  it('copies the bytes, so the caller can change its own bytes after', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const frame = encodeBinaryFrame('["a",null,null]', bytes);
    bytes[0] = 99;

    expect(frame.at(-3)).toBe(1);
  });

  it('accepts an ArrayBuffer and no bytes', () => {
    expect([...encodeBinaryFrame('["a",null,null]', new Uint8Array([7]).buffer)].at(-1)).toBe(7);
    expect(encodeBinaryFrame('["a",null,null]').byteLength).toBe(9 + 15);
  });

  it('copies only the window of a view, not its whole buffer', () => {
    const pool = new Uint8Array([9, 9, 1, 2, 9]);
    const frame = encodeBinaryFrame('["a",null,null]', pool.subarray(2, 4));

    expect([...frame.subarray(9 + 15)]).toEqual([1, 2]);
  });

  it('throws when the envelope is over 64 KiB in UTF-8 bytes', () => {
    const fits = `["a","${'x'.repeat(BINARY_ENVELOPE_LIMIT - 13)}",null]`;
    const over = `["a","${'é'.repeat(BINARY_ENVELOPE_LIMIT / 2)}",null]`;

    expect(new TextEncoder().encode(fits).byteLength).toBe(BINARY_ENVELOPE_LIMIT);
    expect(() => encodeBinaryFrame(fits)).not.toThrow();
    expect(() => encodeBinaryFrame(over)).toThrow(/64 KiB/);
  });
});

describe('splitBinaryFrame', () => {
  it('returns the envelope text and a view of the bytes', () => {
    const result = splitBinaryFrame(encodeBinaryFrame(envelope, picture));

    expect(result).toEqual({ kind: 'frame', envelope, bytes: picture });
  });

  it('does not copy the bytes', () => {
    const frame = encodeBinaryFrame(envelope, picture);
    const result = splitBinaryFrame(frame);

    expect(result.kind === 'frame' && result.bytes.buffer).toBe(frame.buffer);
  });

  it('reads a DataView, an empty envelope and empty bytes', () => {
    const frame = encodeBinaryFrame('');

    expect(splitBinaryFrame(new DataView(frame.buffer))).toEqual({
      kind: 'frame',
      envelope: '',
      bytes: new Uint8Array(0),
    });
  });

  it('reads an ArrayBuffer from another realm', () => {
    const foreignBuffer = runInNewContext('new Uint8Array([1, 2, 3]).buffer') as ArrayBuffer;

    expect([...asUint8Array(foreignBuffer)]).toEqual([1, 2, 3]);
    expect([...encodeBinaryFrame('', foreignBuffer).subarray(9)]).toEqual([1, 2, 3]);
  });

  it('returns foreign for data without the magic', () => {
    expect(splitBinaryFrame(new Uint8Array([1, 2, 3]))).toEqual({ kind: 'foreign' });
    expect(splitBinaryFrame(new Uint8Array([0x6c, 0x74, 0x62]))).toEqual({ kind: 'foreign' });
    expect(splitBinaryFrame(new Uint8Array([0x6c, 0x74, 0x62, 0x67, 1, 0, 0, 0, 0]))).toEqual({
      kind: 'foreign',
    });
    expect(splitBinaryFrame(new Uint8Array(0))).toEqual({ kind: 'foreign' });
  });

  it.each([
    ['magic only', new Uint8Array(MAGIC), 'truncated header'],
    ['a header one byte short', new Uint8Array([...MAGIC, 1, 0, 0, 0]), 'truncated header'],
    ['version 9', new Uint8Array([...MAGIC, 9, 0, 0, 0, 0]), 'unsupported version 9'],
    ['huge length', new Uint8Array([...MAGIC, 1, 255, 255, 255, 255]), 'envelope is too large'],
    ['length past the end', new Uint8Array([...MAGIC, 1, 0, 0, 0, 5, 91]), 'past the frame end'],
    ['invalid UTF-8', new Uint8Array([...MAGIC, 1, 0, 0, 0, 1, 255]), 'not UTF-8'],
    ['truncated UTF-8', withEnvelopeBytes(new Uint8Array([0x5b, 0x22, 0xc3])), 'not UTF-8'],
  ])('rejects %s', (_name, frame, reason) => {
    const result = splitBinaryFrame(frame);

    expect(result.kind).toBe('invalid');
    expect(result.kind === 'invalid' && result.reason).toMatch(reason);
  });

  it('keeps a byte order mark, so the envelope fails JSON.parse as the same text frame would', () => {
    const bom = withEnvelopeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x5d]));

    expect(splitBinaryFrame(bom)).toMatchObject({ kind: 'frame', envelope: '﻿[]' });
  });

  it('accepts an envelope of exactly 64 KiB and rejects one byte more', () => {
    const fits = withEnvelopeBytes(new Uint8Array(BINARY_ENVELOPE_LIMIT).fill(0x20));
    const over = withEnvelopeBytes(new Uint8Array(BINARY_ENVELOPE_LIMIT + 1).fill(0x20));

    expect(splitBinaryFrame(fits).kind).toBe('frame');
    expect(splitBinaryFrame(over)).toMatchObject({ kind: 'invalid' });
  });

  it('reads a frame that sits inside a bigger buffer, like a Buffer from the ws pool', () => {
    const frame = encodeBinaryFrame(envelope, picture);
    const pooled = Buffer.concat([Buffer.alloc(100, 7), Buffer.from(frame), Buffer.alloc(50, 7)]);
    const view = pooled.subarray(100, 100 + frame.byteLength);

    expect(splitBinaryFrame(view)).toEqual({ kind: 'frame', envelope, bytes: picture });
  });

  it('gives a plain Uint8Array for a Buffer, so slice() copies', () => {
    const result = splitBinaryFrame(Buffer.from(encodeBinaryFrame(envelope, picture)));
    if (result.kind !== 'frame') throw new Error('expected a frame');

    expect(Object.getPrototypeOf(result.bytes)).toBe(Uint8Array.prototype);
    const copy = result.bytes.slice();
    copy[0] = 0;
    expect(result.bytes[0]).toBe(137);
  });
});

describe('asUint8Array', () => {
  it('views an ArrayBuffer, a DataView and a Buffer without copying', () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const fromBuffer = asUint8Array(buffer);
    const fromView = asUint8Array(new DataView(buffer, 1, 2));
    const fromNodeBuffer = asUint8Array(Buffer.from(buffer, 2, 2));

    expect([...fromBuffer]).toEqual([1, 2, 3, 4]);
    expect([...fromView]).toEqual([2, 3]);
    expect([...fromNodeBuffer]).toEqual([3, 4]);
    expect(fromView.buffer).toBe(buffer);
    expect(Object.getPrototypeOf(fromNodeBuffer)).toBe(Uint8Array.prototype);
  });

  it('returns a plain Uint8Array unchanged', () => {
    const bytes = new Uint8Array(2);

    expect(asUint8Array(bytes)).toBe(bytes);
  });
});
