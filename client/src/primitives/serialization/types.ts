import type { LiveThingMetadata } from '@livething/core';

/** What `parseBinary` returns after decoding a binary frame. */
export interface ParsedFrame {
  event: string;
  payload: unknown;
  metadata?: LiveThingMetadata | null;
}

/** Binary frames delivered as `ArrayBuffer`. */
export interface ArrayBufferSerialization {
  binaryType: 'arraybuffer';
  parseBinary: (data: ArrayBuffer) => ParsedFrame | null;
}

/** Binary frames delivered as `Blob`. */
export interface BlobSerialization {
  binaryType: 'blob';
  parseBinary: (data: Blob) => ParsedFrame | null;
}
