import { BINARY_HEADER_LENGTH, utf8ByteLength } from '@livething/core';

/*
 * The size rules for a message that LiveThing stores to send again later: replay rows, inbox
 * rows and recorded stream chunks. A stored message is JSON text, and a binary one has its
 * bytes too.
 */

/** What a byte limit counts for one stored message: the JSON's UTF-8 bytes plus the binary bytes. */
export function storedRowBytes(payloadJson: string, bytes: Uint8Array | null | undefined): number {
  return utf8ByteLength(payloadJson) + (bytes?.byteLength ?? 0);
}

/**
 * About how many bytes one row takes in storage: what `storedRowBytes` counts, the text of its
 * other columns, and a little for its numbers. Compared with the SQL engine's row limit.
 */
export function storedRowStorageBytes(
  rowBytes: number,
  columns: readonly (string | null | undefined)[],
): number {
  let bytes = rowBytes + 64;
  for (const value of columns) bytes += value ? utf8ByteLength(value) : 0;

  return bytes;
}

/** The limits that keep a message out of storage. */
export interface StoredRowLimits {
  /** The SQL engine's row limit: a bigger write would throw. */
  maxValueBytes: number;
  /** The adapter's `sendBytes`: a bigger message was never sent, and could never be sent again. */
  sendBytes?: number;
  /** A byte limit on all the rows together: one bigger row would push out every row, itself too. */
  maxBytes?: number;
}

/** Why a message was not stored, and the limit it is over. */
export interface StoredRowSkip {
  limit: 'storage' | 'send' | 'retention';
  bytes: number;
}

/** The sizes of one row that the limits are checked against. */
interface StoredRowSize {
  /** From `storedRowStorageBytes`. */
  storageBytes: number;
  /** From `storedRowBytes`. */
  rowBytes: number;
}

/** The limit a row is over, or `null` when it may be stored. */
export function storedRowSkip(row: StoredRowSize, limits: StoredRowLimits): StoredRowSkip | null {
  if (row.storageBytes > limits.maxValueBytes) {
    return { limit: 'storage', bytes: limits.maxValueBytes };
  }

  // The frame sent again is about the size of the row, plus the binary frame's header.
  if (
    limits.sendBytes !== undefined &&
    row.storageBytes + BINARY_HEADER_LENGTH > limits.sendBytes
  ) {
    return { limit: 'send', bytes: limits.sendBytes };
  }

  if (limits.maxBytes !== undefined && row.rowBytes > limits.maxBytes) {
    return { limit: 'retention', bytes: limits.maxBytes };
  }

  return null;
}

/** Stored bytes as a `Uint8Array`: `node:sqlite` reads a BLOB as one, Cloudflare as an `ArrayBuffer`. */
export function toBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Uint8Array) return value;

  return new Uint8Array(value as ArrayBuffer);
}
