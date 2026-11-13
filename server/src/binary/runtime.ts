import { CloseCodes, splitBinaryFrame } from '@livething/core';
import { processFrame } from '~/_engine/runtime/messages.ts';
import { binaryPayload } from '~/outgoing/binary-payload.ts';
import type { BinaryInput } from '@livething/core';
import type { SenderEventPosition } from '~/_engine/runtime/feature-slots.ts';
import type { FrameRuntime } from '~/_engine/runtime/messages.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

/**
 * Cut a binary message into its envelope and its bytes, with no `await`, then send it
 * through the same steps as a text frame. A message without the magic is not LiveThing
 * data, so it closes the socket with `1003`. A frame with the magic that cannot be read
 * is logged and dropped, like broken JSON text.
 */
export async function processBinaryMessage(
  runtime: FrameRuntime,
  connection: RuntimeConnection,
  data: Uint8Array,
): Promise<void> {
  const split = splitBinaryFrame(data);
  if (split.kind === 'foreign') {
    connection.closing = true;
    connection.descriptor.close(
      CloseCodes.UNSUPPORTED_DATA,
      '[livething] binary data without the LiveThing header',
    );
    return;
  }

  const size = data.byteLength;
  if (split.kind === 'invalid') {
    await processFrame(runtime, connection, {
      parsed: undefined,
      size,
      invalid: `Invalid binary message dropped: ${split.reason}`,
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(split.envelope);
  } catch {
    await processFrame(runtime, connection, {
      parsed: undefined,
      size,
      invalid: 'Invalid binary message dropped: the envelope is not JSON',
    });
    return;
  }

  await processFrame(runtime, connection, { parsed, size, bytes: split.bytes });
}

type SendMethod = (...args: unknown[]) => unknown;

/**
 * Give a sender a `.binary` key. Each binary method, `name(event, bytes, { info, ...rest })`,
 * calls the JSON method of the same name with the info and the bytes in the payload's place,
 * so it has the same audience, options and return value. `request` works the same way, and
 * the request runtime sees the binary payload. It reads the JSON method off `this` when
 * called, so a plugin's scoped `ctx` (a Proxy) still adds its namespace to the event name.
 */
export function addBinarySenders(
  sender: object,
  methods: Readonly<Record<string, SenderEventPosition>>,
): void {
  Object.defineProperty(sender, 'binary', {
    configurable: true,
    get(this: Record<string, SendMethod>) {
      const senders: Record<string, SendMethod> = {};
      for (const [name, position] of Object.entries(methods)) {
        // `request` is there only when `serverRequests()` added it to this sender.
        if (typeof this[name] !== 'function') continue;

        senders[name] = (event, bytes, options) => {
          const { info, ...rest } = (options ?? {}) as Record<string, unknown>;
          const payload = binaryPayload(info, bytes as BinaryInput | undefined);
          if (position === 'replay') return this[name]!(event, payload, rest.wire);

          if (position === 'event-first') {
            return Object.keys(rest).length > 0
              ? this[name]!(event, payload, rest)
              : this[name]!(event, payload);
          }

          return this[name]!(rest[position.targetKey], event, payload);
        };
      }

      return senders;
    },
  });
}
