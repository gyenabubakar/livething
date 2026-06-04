import type {
  ArrayBufferSerialization,
  BlobSerialization,
  ParsedFrame,
} from '~/primitives/serialization/types.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/**
 * Lets the client handle binary messages (Protocol Buffers, MessagePack, etc.).
 * You set the delivery format and a decoder, and they go together — TypeScript
 * won't let you give one without the other. Text frames always use the built-in
 * JSON format.
 *
 * ```ts
 * serialization({ binaryType: 'arraybuffer', parseBinary: (data) => decode(data) });
 * ```
 */
export function serialization(
  options: ArrayBufferSerialization | BlobSerialization,
): Primitive<EmptyTypeFn> {
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
