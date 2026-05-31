import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** A decoded binary frame returned by `parseBinary`. */
export interface ParsedFrame {
  event: string;
  payload: unknown;
}

/** Binary handling with `ArrayBuffer` delivery. */
export interface ArrayBufferSerialization {
  binaryType: 'arraybuffer';
  parseBinary: (data: ArrayBuffer) => ParsedFrame | null;
}

/** Binary handling with `Blob` delivery. */
export interface BlobSerialization {
  binaryType: 'blob';
  parseBinary: (data: Blob) => ParsedFrame | null;
}

/**
 * Configure binary message handling. `binaryType` and `parseBinary` are linked —
 * provide both or neither (TypeScript enforces it). Text frames always use the
 * fixed `{ event, payload }` JSON codec.
 *
 * ```ts
 * serialization({ binaryType: 'arraybuffer', parseBinary: (d) => decode(d) });
 * ```
 */
export function serialization(
  options: ArrayBufferSerialization | BlobSerialization,
): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'serialization',
    applyConfig(config) {
      config.binaryType = options.binaryType;
      const parse = options.parseBinary as (data: unknown) => ParsedFrame | null;
      config.parseBinary = (data) => {
        const frame = parse(data);
        return frame ? { event: frame.event, payload: frame.payload } : null;
      };
    },
  };
}
