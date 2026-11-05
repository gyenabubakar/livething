/* oxlint-disable max-params -- binary.send takes (event, info, bytes, options), as the spec sets */
import {
  asUint8Array,
  BINARY_ENVELOPE_LIMIT,
  BINARY_HEADER_LENGTH,
  decodeMessage,
  encodeBinaryFrame,
  encodeMessage,
  LiveThingConfigError,
  splitBinaryFrame,
  utf8ByteLength,
} from '@livething/core';
import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { getAugmenters, scopedName } from '~/internal/scoped.ts';
import { isReservedEventName } from '~/internal/wire-validation.ts';
import type { BinaryInput } from '@livething/core';
import type { Message } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { SendOptions } from '~/messaging.ts';
import type { BinaryOptions, BinaryPrimitive } from '~/primitives/binary/types.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';

type BinaryListener = (info: unknown, bytes: Uint8Array) => void;

/**
 * Why the platform's `TextDecoder` cannot read frames, or `null` when it can. The frame
 * parser needs `fatal: true`, so a polyfill that ignores it is refused.
 */
function textDecoderProblem(): string | null {
  if (typeof TextDecoder !== 'function') {
    return 'binary() needs TextDecoder, which this platform does not have. On React Native, add a TextDecoder polyfill that supports fatal: true.';
  }

  const notStrict =
    "binary() needs a TextDecoder that honours fatal: true, and this platform's TextDecoder does not honour fatal: true. Replace it with a TextDecoder polyfill that supports fatal: true.";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  } catch {
    return notStrict;
  }

  try {
    decoder.decode(new Uint8Array([0xff]));
    return notStrict;
  } catch {
    return null;
  }
}

/** A `Uint8Array`, another view, or an `ArrayBuffer`, also one from another realm (an iframe). */
function isBinaryInput(value: unknown): value is BinaryInput {
  return (
    ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  );
}

/** A listener's scope and event, JSON-encoded so no name can clash with another. */
function listenerKey(markers: ScopeMarkers, event: string): string {
  return JSON.stringify([markers.name ?? null, markers.family ?? null, event]);
}

/**
 * Binary messages: a JSON info and raw bytes in one frame. Adds `socket.binary.on` and
 * `socket.binary.send`, and the same on channel handles and plugin sockets. It sets the
 * WebSocket's `binaryType` to `'arraybuffer'`, so frames are read with no `await` and
 * keep their order.
 */
export function binary(options: BinaryOptions = {}): BinaryPrimitive {
  const maxFrameBytes = options.maxFrameBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new LiveThingConfigError(
      `binary maxFrameBytes must be a positive integer, got ${maxFrameBytes}.`,
    );
  }

  return {
    _tag: 'binary',
    setup(helpers) {
      const decoderProblem = textDecoderProblem();
      if (decoderProblem) throw new LiveThingConfigError(decoderProblem);

      const listeners = new Map<string, Set<BinaryListener>>();
      let socket: LiveThingSocket;

      function on(markers: ScopeMarkers, event: string, listener: BinaryListener): () => void {
        helpers.lazyAcquire();
        const key = listenerKey(markers, event);
        let set = listeners.get(key);
        if (!set) {
          set = new Set();
          listeners.set(key, set);
        }

        const owned = set;
        owned.add(listener);
        let released = false;

        return () => {
          if (released) return;

          released = true;
          owned.delete(listener);
          if (owned.size === 0 && listeners.get(key) === owned) listeners.delete(key);
          helpers.lazyRelease();
        };
      }

      // ponytail: the info is encoded once here for the size check and again on the wire.
      function send(
        markers: ScopeMarkers,
        event: string,
        info: unknown,
        bytes?: BinaryInput,
        sendOptions?: SendOptions,
      ): boolean {
        if (typeof event !== 'string' || event.length === 0 || isReservedEventName(event)) {
          return false;
        }

        if (bytes !== undefined && !isBinaryInput(bytes)) {
          throw new TypeError(
            `[livething] The bytes of binary.send('${event}') must be a Uint8Array or an ArrayBuffer, got ${bytes === null ? 'null' : typeof bytes}.`,
          );
        }

        const message: Message = {
          event,
          payload: info,
          metadata: markers.name === undefined ? null : { channel: markers as { name: string } },
          bytes: bytes === undefined ? new Uint8Array(0) : asUint8Array(bytes),
        };

        const envelopeBytes = utf8ByteLength(encodeMessage(message));
        if (envelopeBytes > BINARY_ENVELOPE_LIMIT) {
          throw new RangeError(
            `[livething] the binary frame's info and metadata are ${envelopeBytes} bytes, over the 64 KiB limit. Put large data in the bytes.`,
          );
        }

        const frameBytes = BINARY_HEADER_LENGTH + envelopeBytes + message.bytes!.byteLength;
        if (frameBytes > maxFrameBytes) {
          helpers.log.info(
            `binary send('${event}') dropped: the frame is ${frameBytes} bytes, over maxFrameBytes (${maxFrameBytes})`,
          );
          return false;
        }

        if (helpers.log.debug) {
          helpers.log.info(`binary send('${event}')`, info, `<${message.bytes!.byteLength} bytes>`);
        }

        const result = helpers.send(message, sendOptions);

        return result === 'sent' || result === 'buffered';
      }

      function receive(data: unknown): void {
        if (!isBinaryInput(data)) {
          helpers.log.report(
            new Error('[livething] a binary message that is not an ArrayBuffer was dropped.'),
          );
          return;
        }

        const split = splitBinaryFrame(data);
        if (split.kind === 'foreign') {
          helpers.log.report(
            new Error('[livething] a binary message without the LiveThing header was dropped.'),
          );
          return;
        }

        if (split.kind === 'invalid') {
          helpers.log.info(`could not parse a binary message (${split.reason}) — dropping it`);
          return;
        }

        const message = decodeMessage(split.envelope);
        if (!message) {
          helpers.log.info('could not parse the envelope of a binary message — dropping it');
          return;
        }

        message.bytes = split.bytes;
        socket._processIncoming(message);
      }

      function route(message: Message): void {
        const metadata = message.metadata;
        const bytes = message.bytes!;
        const exchange = metadata?.exchange;
        // Requests and streams are matched by their exchange and stream ids, before the
        // channel, because a request inside a channel carries `channel` too.
        const fromServer = exchange?.source === 'server';
        if (exchange?.id !== undefined && fromServer && helpers.hasPrimitive('serverRequests')) {
          // No binary.onRequest yet: decline at once, as serverRequests() does for a request
          // with no handler, so the server does not wait for its timeout. The server takes a
          // text `__error__` as the answer to a binary request.
          helpers.rawSend({
            event: '__error__',
            payload: { code: 'request-no-response' },
            metadata: {
              exchange: { id: exchange.id, source: 'server' },
              ...(metadata!.channel ? { channel: { ...metadata!.channel } } : {}),
            },
          });
          return;
        }

        // Without serverRequests() a top-level server request is a plain event, and a channel
        // one reaches no listener, the same as for text.
        if (
          (exchange?.id !== undefined && (!fromServer || metadata?.channel)) ||
          metadata?.stream?.id !== undefined
        ) {
          helpers.log.info(`no binary request or stream takes '${message.event}' — dropping it`);
          return;
        }

        if (helpers.log.debug) {
          helpers.log.info(
            `received binary '${message.event}'`,
            message.payload,
            `<${bytes.byteLength} bytes>`,
          );
        }

        dispatchToHandlers(
          listeners.get(listenerKey(metadata?.channel ?? {}, message.event)),
          helpers.log,
          message.payload,
          bytes,
        );
      }

      return {
        id: 'binary',
        install(installedSocket) {
          socket = installedSocket;
          socket._binary = {
            receive,
            route,
            encode: (message) =>
              message.bytes
                ? encodeBinaryFrame(encodeMessage(message), message.bytes)
                : encodeMessage(message),
          };

          // @ts-expect-error — install adds `binary` to the socket dynamically
          installedSocket.binary = {
            on: (event: string, listener: BinaryListener) => on({}, event, listener),
            send: (event: string, info: unknown, bytes?: BinaryInput, sendOptions?: SendOptions) =>
              send({}, event, info, bytes, sendOptions),
          };

          getAugmenters(installedSocket).push((messaging, scope) => {
            messaging.binary = {
              on: (event: string, listener: BinaryListener) =>
                on(scope.markers(), scopedName(scope, event), listener),
              send(event: string, info: unknown, bytes?: BinaryInput, sendOptions?: SendOptions) {
                scope.assertReady?.();
                return send(scope.markers(), scopedName(scope, event), info, bytes, sendOptions);
              },
            };
          });
        },
      };
    },
  };
}

binary.tag = 'binary' as const;
