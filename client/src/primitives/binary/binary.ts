import {
  asUint8Array,
  BINARY_ENVELOPE_LIMIT,
  BINARY_HEADER_LENGTH,
  decodeMessage,
  encodeBinaryFrame,
  encodeMessage,
  LiveThingConfigError,
  LiveThingError,
  splitBinaryFrame,
  utf8ByteLength,
} from '@livething/core';
import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { REQUESTS_KEY, STREAM_KEY } from '~/internal/runtime.ts';
import { binaryOf, getAugmenters, scopedName } from '~/internal/scoped.ts';
import { isReservedEventName } from '~/internal/wire-validation.ts';
import type { BinaryInput } from '@livething/core';
import type {
  Message,
  SendRequest,
  StreamContinueContext,
  StreamHooks,
} from '~/internal/runtime.ts';
import type { ScopeInfo, ScopeMarkers } from '~/internal/scoped.ts';
import type { SendOptions } from '~/messaging.ts';
import type { BinaryOptions, BinaryPrimitive } from '~/primitives/binary/types.ts';
import type { StreamTriggerOptions } from '~/primitives/stream/types.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { StreamHandlers } from '~/types.ts';

interface BinarySendOptions extends SendOptions {
  info?: unknown;
}

interface OutgoingFrame extends BinarySendOptions {
  bytes?: BinaryInput;
}

interface BinaryStreamOptions extends StreamTriggerOptions {
  info?: unknown;
}

interface RequestOptions {
  info?: unknown;
  timeout?: number;
}

type BinaryListener = (info: unknown, bytes: Uint8Array) => void;
type BinaryAnswerer = (info: unknown, bytes: Uint8Array) => unknown;

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
 * `socket.binary.send`, and the same on channel handles and plugin sockets.
 * `clientRequests()`, `serverRequests()` and `stream()` add `binary.request`,
 * `binary.onRequest`, `binary.stream`, `binary.onStream` and `binary.continueStream` next to
 * them. It sets the
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
      // `binary.onRequest` handlers, keyed like the listeners.
      const answerers = new Map<string, BinaryAnswerer>();
      const withServerRequests = helpers.hasPrimitive('serverRequests');
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

      /**
       * `message` with `bytes` as a `Uint8Array` (none means zero bytes), and the size of
       * its whole frame. Throws when the bytes are not binary, or when the info and the
       * metadata are over the 64 KiB envelope limit.
       */
      // ponytail: the info is encoded once here for the size check and again on the wire.
      function withBytes(
        method: string,
        message: Message,
        bytes: unknown,
      ): { message: Message; size: number } {
        if (bytes !== undefined && !isBinaryInput(bytes)) {
          throw new TypeError(
            `[livething] The bytes of ${method} must be a Uint8Array or an ArrayBuffer, got ${bytes === null ? 'null' : typeof bytes}.`,
          );
        }

        const framed = {
          ...message,
          bytes: bytes === undefined ? new Uint8Array(0) : asUint8Array(bytes),
        };

        const envelopeBytes = utf8ByteLength(encodeMessage(framed));
        if (envelopeBytes > BINARY_ENVELOPE_LIMIT) {
          throw new RangeError(
            `[livething] the binary frame's info and metadata are ${envelopeBytes} bytes, over the 64 KiB limit. Put large data in the bytes.`,
          );
        }

        return {
          message: framed,
          size: BINARY_HEADER_LENGTH + envelopeBytes + framed.bytes.byteLength,
        };
      }

      function send(markers: ScopeMarkers, event: string, frame: OutgoingFrame): boolean {
        const { bytes, info, ...sendOptions } = frame;
        if (typeof event !== 'string' || event.length === 0 || isReservedEventName(event)) {
          return false;
        }

        const { message, size } = withBytes(
          `binary.send('${event}')`,
          {
            event,
            payload: info,
            metadata: markers.name === undefined ? null : { channel: markers as { name: string } },
          },
          bytes,
        );
        if (size > maxFrameBytes) {
          helpers.log.info(
            `binary send('${event}') dropped: the frame is ${size} bytes, over maxFrameBytes (${maxFrameBytes})`,
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
        // clientRequests(), stream() and binary()'s own onIncoming claim their frames before this. What
        // is left of a reply or a chunk has no taker. Without serverRequests() a top-level
        // server request is a plain event, and a channel one reaches no listener, as for text.
        if (
          (exchange?.id !== undefined && (exchange.source !== 'server' || metadata?.channel)) ||
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

      /** `message` as one binary frame, or a throw when it cannot be sent. */
      function frameOf(method: string, message: Message, bytes: unknown): Message {
        const framed = withBytes(method, message, bytes);
        if (framed.size > maxFrameBytes) {
          throw new RangeError(
            `[livething] the frame of ${method} is ${framed.size} bytes, over maxFrameBytes (${maxFrameBytes}).`,
          );
        }

        return framed.message;
      }

      // The answer to a binary server request: one binary frame, or a text decline.
      async function answer(
        message: Message,
        answerer: BinaryAnswerer,
        metadata: Message['metadata'],
      ): Promise<void> {
        const method = `binary.onRequest('${message.event}')`;
        try {
          const result = (await answerer(message.payload, message.bytes!)) as {
            info?: unknown;
            bytes?: unknown;
          };
          if (typeof result !== 'object' || result === null || !('info' in result)) {
            throw new TypeError(`[livething] ${method} must return { info, bytes }.`);
          }

          helpers.rawSend(
            frameOf(method, { event: message.event, payload: result.info, metadata }, result.bytes),
          );
        } catch (error) {
          helpers.log.warn(`${method} handler threw`, error);
          helpers.rawSend({
            event: '__error__',
            payload: { code: 'request-no-response' },
            metadata,
          });
        }
      }

      function onRequest(markers: ScopeMarkers, event: string, answerer: BinaryAnswerer) {
        const key = listenerKey(markers, event);
        if (answerers.has(key)) {
          helpers.log.warn(`a second binary.onRequest('${event}') handler replaced the first`);
        }

        answerers.set(key, answerer);

        return () => {
          if (answerers.get(key) === answerer) answerers.delete(key);
        };
      }

      /**
       * The methods that need another primitive too, for one scope (`null` is the top
       * level): requests with `clientRequests()`, answers with `serverRequests()`, and
       * streams with `stream()`. They use that primitive's own machinery.
       */
      function exchanges(scope: ScopeInfo | null): Record<string, unknown> {
        function markers(): ScopeMarkers {
          return scope ? scope.markers() : {};
        }

        function wireName(event: string): string {
          return scope ? scopedName(scope, event) : event;
        }

        function hooks(): StreamHooks {
          return helpers.shared.get(STREAM_KEY) as StreamHooks;
        }

        const methods: Record<string, unknown> = {};

        if (helpers.hasPrimitive('clientRequests')) {
          methods.request = (event: string, bytes: unknown, requestOptions?: RequestOptions) => {
            scope?.assertReady?.();
            const name = wireName(event);
            try {
              return (helpers.shared.get(REQUESTS_KEY) as SendRequest)(name, requestOptions?.info, {
                markers: markers(),
                timeout: requestOptions?.timeout,
                prepare: (frame) => frameOf(`binary.request('${name}')`, frame, bytes),
                answer(reply, settle) {
                  if (reply.bytes) {
                    settle.resolve({ info: reply.payload, bytes: reply.bytes });
                  } else {
                    settle.reject(
                      new LiveThingError('request-invalid-response', {
                        event: name,
                        issues: [{ message: 'The reply must be a binary frame.' }],
                      }),
                    );
                  }
                },
              });
            } catch (error) {
              return Promise.reject(error);
            }
          };
        }

        if (withServerRequests) {
          methods.onRequest = (event: string, answerer: BinaryAnswerer) =>
            onRequest(markers(), wireName(event), answerer);
        }

        if (helpers.hasPrimitive('stream')) {
          methods.stream = (event: string, bytes: unknown, given: BinaryStreamOptions = {}) => {
            const { info, ...streamOptions } = given;
            scope?.assertReady?.();
            const name = wireName(event);
            try {
              return hooks().start(name, info, {
                markers: markers(),
                options: streamOptions,
                binary: true,
                prepare: (frame) => frameOf(`binary.stream('${name}')`, frame, bytes),
              });
            } catch (error) {
              return Promise.reject(error);
            }
          };
          methods.onStream = (event: string, handlers: StreamHandlers<unknown>) =>
            hooks().listen(wireName(event), handlers, {
              ...(scope ? { scope: scope.markers() } : {}),
              binary: true,
            });
          methods.continueStream = (
            event: string,
            streamId: string,
            continueOptions?: StreamContinueContext['options'],
          ) => {
            scope?.assertReady?.();
            return hooks().continue(wireName(event), streamId, {
              markers: markers(),
              options: continueOptions,
              binary: true,
            });
          };
        }

        return methods;
      }

      return {
        id: 'binary',

        // A binary server request, with `serverRequests()`. Without it, `route` gives a
        // top-level one to `binary.on`, as for text.
        onIncoming(message) {
          const metadata = message.metadata;
          const exchange = metadata?.exchange;
          if (!withServerRequests || !message.bytes || exchange?.source !== 'server') {
            return message;
          }

          const channel = metadata!.channel;
          const reply: Message['metadata'] = {
            exchange: { id: exchange.id, source: 'server' },
            ...(channel ? { channel: { ...channel } } : {}),
          };

          const answerer = answerers.get(listenerKey(channel ?? {}, message.event));
          // No handler: decline at once, so the server does not wait for its timeout.
          if (answerer) {
            void answer(message, answerer, reply);
          } else {
            helpers.rawSend({
              event: '__error__',
              payload: { code: 'request-no-response' },
              metadata: reply,
            });
          }

          return null;
        },

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

          Object.assign(binaryOf(installedSocket), exchanges(null), {
            on: (event: string, listener: BinaryListener) => on({}, event, listener),
            send: (event: string, bytes?: BinaryInput, sendOptions?: BinarySendOptions) =>
              send({}, event, { ...sendOptions, bytes }),
          });

          getAugmenters(installedSocket).push((messaging, scope) => {
            Object.assign(binaryOf(messaging), exchanges(scope), {
              on: (event: string, listener: BinaryListener) =>
                on(scope.markers(), scopedName(scope, event), listener),
              send(event: string, bytes?: BinaryInput, sendOptions?: BinarySendOptions) {
                scope.assertReady?.();
                return send(scope.markers(), scopedName(scope, event), { ...sendOptions, bytes });
              },
            });
          });
        },
      };
    },
  };
}

binary.tag = 'binary' as const;
