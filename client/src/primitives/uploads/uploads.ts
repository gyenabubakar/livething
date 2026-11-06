import { asUint8Array, UploadAborted } from '@livething/core';
import { Disconnected, Timeout } from '~/errors.ts';
import { toLiveThingError, unscopeErrorCode } from '~/internal/error-frame.ts';
import { idGenerator } from '~/internal/id.ts';
import { binaryOf, getAugmenters, scopedName } from '~/internal/scoped.ts';
import { wireIdError } from '~/internal/wire-validation.ts';
import type { LiveThingError } from '@livething/core';
import type { Message } from '~/internal/runtime.ts';
import type {
  Upload,
  UploadOptions,
  UploadSource,
  UploadsPrimitive,
} from '~/primitives/uploads/types.ts';

/** What the server's acks say. */
interface Ack {
  receivedThrough: number;
  savedThrough: number;
  pieceBytes?: number;
  windowBytes?: number;
}

/** One frame the server sent to a running upload. */
type UploadEvent =
  | { kind: 'ack'; ack: Ack }
  | { kind: 'done'; info: unknown }
  | { kind: 'error'; error: LiveThingError }
  | { kind: 'closed' }
  | { kind: 'no-answer' };

/** A running `start()`: the frames that came for it, and a way to wait for the next one. */
interface Attempt {
  events: UploadEvent[];
  wake?: () => void;
  /**
   * Set once this start's first ack came. An `interrupted` before it belongs to an earlier
   * start's late pieces, so it is skipped.
   */
  acked?: boolean;
}

/** How long a start waits for the server's first answer. */
const FIRST_ANSWER_MS = 30_000;

const EMPTY = new Uint8Array(0);

function isAsyncIterable(source: UploadSource): source is AsyncIterable<Uint8Array> {
  return typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

function isBlob(source: UploadSource): source is Blob {
  return typeof Blob === 'function' && source instanceof Blob;
}

/** The total size of a source the client can measure, or `undefined` for an `AsyncIterable`. */
function sizeOf(source: UploadSource): number | undefined {
  if (isAsyncIterable(source)) return undefined;

  return isBlob(source) ? source.size : asUint8Array(source).byteLength;
}

/** The pieces of `source` from `start`, each at most `pieceBytes` long. */
async function* piecesOf(
  source: UploadSource,
  start: number,
  pieceBytes: number,
): AsyncGenerator<Uint8Array> {
  if (isBlob(source)) {
    for (let offset = start; offset < source.size; offset += pieceBytes) {
      yield new Uint8Array(await source.slice(offset, offset + pieceBytes).arrayBuffer());
    }

    return;
  }

  if (!isAsyncIterable(source)) {
    const bytes = asUint8Array(source);
    for (let offset = start; offset < bytes.byteLength; offset += pieceBytes) {
      yield bytes.subarray(offset, offset + pieceBytes);
    }

    return;
  }

  // Skip the bytes the server already saved, then copy the rest into pieces, each byte once.
  let skip = start;
  let piece = new Uint8Array(pieceBytes);
  let filled = 0;
  for await (const chunk of source) {
    let bytes = chunk;
    if (skip > 0) {
      const skipped = Math.min(skip, bytes.byteLength);
      skip -= skipped;
      bytes = bytes.subarray(skipped);
    }

    while (bytes.byteLength > 0) {
      const take = Math.min(bytes.byteLength, pieceBytes - filled);
      piece.set(bytes.subarray(0, take), filled);
      filled += take;
      bytes = bytes.subarray(take);
      if (filled === pieceBytes) {
        yield piece;
        piece = new Uint8Array(pieceBytes);
        filled = 0;
      }
    }
  }

  if (filled > 0) yield piece.subarray(0, filled);
}

/**
 * Uploads: send one large file to a server's `base.binary.upload(...)` handler in pieces,
 * with speed control, cancel and resume. Adds `socket.binary.upload(event, input, source)`,
 * which returns an upload that starts only when you call `start()`. Needs `binary()`.
 *
 * The pieces go straight to the socket, never to `buffering()`'s queue: a piece sent after a
 * reconnect must follow the server's answer to the new start.
 */
export function uploads(): UploadsPrimitive {
  return {
    _tag: 'uploads',
    dependencies: ['binary'],
    setup(helpers) {
      const running = new Map<string, Attempt>();

      function deliver(uploadId: string, event: UploadEvent): boolean {
        const attempt = running.get(uploadId);
        if (!attempt) return false;

        attempt.events.push(event);
        attempt.wake?.();

        return true;
      }

      async function next(attempt: Attempt): Promise<UploadEvent> {
        while (attempt.events.length === 0) {
          await new Promise<void>((resolve) => {
            attempt.wake = resolve;
          });
          attempt.wake = undefined;
        }

        return attempt.events.shift()!;
      }

      /** Resolves once the socket is open, or rejects with `Disconnected` when it cannot be. */
      function whenOpen(): Promise<void> {
        return new Promise((resolve, reject) => {
          function check(): boolean {
            const state = helpers.getState();
            if (state === 'open') resolve();
            else if (state === 'closed') reject(Disconnected());
            else return false;

            return true;
          }

          if (check()) return;

          const stop = helpers.state.subscribe(() => {
            if (check()) stop();
          });
        });
      }

      function send(message: Message): void {
        if (helpers.rawSend(message) !== 'sent') throw Disconnected();
      }

      /** The errors that came from the server, which stopped the upload itself. */
      const stoppedByServer = new WeakSet<object>();
      /** Cancels made while the socket was not open. They go out when it opens. */
      const pendingCancels = new Set<string>();

      function cancelFrame(uploadId: string): Message {
        return { event: '__uploadCancel__', payload: null, metadata: { upload: { id: uploadId } } };
      }

      function sendCancel(uploadId: string): void {
        if (helpers.rawSend(cancelFrame(uploadId)) !== 'sent') pendingCancels.add(uploadId);
      }

      function flushCancels(): Message[] | null {
        if (pendingCancels.size === 0) return null;

        const frames = [...pendingCancels].map(cancelFrame);
        pendingCancels.clear();
        return frames;
      }

      // oxlint-disable-next-line max-params -- binary.upload takes (event, input, source, options), like binary.send
      function create(
        event: string,
        input: unknown,
        source: UploadSource,
        options: UploadOptions = {},
      ): Upload<unknown> {
        const eventError = wireIdError(event, event, 'event');
        if (eventError) throw eventError;

        const id = options.uploadId ?? idGenerator(helpers)('upl');
        const idError = wireIdError(event, id, 'uploadId');
        if (idError) throw idError;

        const size = sizeOf(source);
        const listeners = new Set<(receivedBytes: number) => void>();
        let current: Promise<{ info: unknown }> | undefined;
        let result: { info: unknown } | undefined;
        let cancelled = false;

        let iterableRead = false;
        /** Whether a start was ever sent, so the server may hold a record. */
        let everStarted = false;
        /** The highest saved offset the server reported. */
        let savedHigh = 0;
        /** Ends a start that waits for the socket to open, when the upload is cancelled. */
        let stopWaiting: (() => void) | undefined;

        function progress(receivedBytes: number): void {
          for (const listener of listeners) {
            try {
              listener(receivedBytes);
            } catch (error) {
              helpers.log.report(error);
            }
          }
        }

        /** Wait for frames until one answers; acks along the way update the progress. */
        async function settle(pending: Attempt, until: 'ack' | 'done'): Promise<UploadEvent> {
          while (true) {
            const answer = await next(pending);
            if (answer.kind === 'closed') throw Disconnected();

            if (answer.kind === 'no-answer') throw Timeout();

            if (answer.kind === 'error') {
              const stale =
                !pending.acked &&
                UploadAborted.matches(answer.error) &&
                answer.error.detail.reason === 'interrupted';
              if (stale) continue;

              stoppedByServer.add(answer.error);
              throw answer.error;
            }

            if (answer.kind === 'ack') {
              savedHigh = Math.max(savedHigh, answer.ack.savedThrough);
              progress(answer.ack.receivedThrough);
            }

            if (answer.kind === 'done' || until === 'ack') return answer;
          }
        }

        async function attempt(): Promise<{ info: unknown }> {
          if (isAsyncIterable(source)) {
            if (iterableRead) {
              // The upload cannot go on, so the server need not keep its record.
              if (everStarted) sendCancel(id);

              everStarted = false;

              throw UploadAborted({ reason: 'not-resumable' });
            }

            iterableRead = true;
          }

          helpers.lazyAcquire();
          const run: Attempt = { events: [] };
          let started = false;
          // A start that gets no answer (an intercept dropped it) must not wait forever.
          let noAnswer: ReturnType<typeof setTimeout> | undefined;
          try {
            helpers.ensureConnected();
            await new Promise<void>((resolve, reject) => {
              stopWaiting = () => reject(UploadAborted({ reason: 'cancelled' }));
              whenOpen().then(resolve, reject);
            });
            stopWaiting = undefined;
            if (cancelled) throw UploadAborted({ reason: 'cancelled' });

            running.set(id, run);
            send({
              event,
              payload: input,
              metadata: { upload: { id, ...(size === undefined ? {} : { size }) } },
              bytes: EMPTY,
            });
            started = true;
            everStarted = true;
            noAnswer = setTimeout(() => {
              run.events.push({ kind: 'no-answer' });
              run.wake?.();
            }, FIRST_ANSWER_MS);

            // The first ack of this start says the piece size. A late ack of an earlier
            // start can come first: skip it.
            let first = await settle(run, 'ack');
            while (first.kind === 'ack' && first.ack.pieceBytes === undefined) {
              first = await settle(run, 'ack');
            }

            clearTimeout(noAnswer);
            run.acked = true;

            if (first.kind === 'done') return { info: first.info };

            const { savedThrough, pieceBytes, windowBytes } = (first as { ack: Required<Ack> }).ack;

            let receivedThrough = savedThrough;
            let sent = savedThrough;
            let seq = 0;
            for await (const piece of piecesOf(source, savedThrough, pieceBytes)) {
              while (sent + piece.byteLength - receivedThrough > windowBytes) {
                const answer = await settle(run, 'ack');
                if (answer.kind === 'done') return { info: answer.info };

                receivedThrough = (answer as { ack: Ack }).ack.receivedThrough;
              }

              if (cancelled) throw UploadAborted({ reason: 'cancelled' });

              seq += 1;
              send({ event, payload: null, metadata: { upload: { id, seq } }, bytes: piece });
              sent += piece.byteLength;
            }

            send({
              event: '__uploadEnd__',
              payload: { totalBytes: sent },
              metadata: { upload: { id } },
            });

            const done = await settle(run, 'done');
            return { info: (done as { info: unknown }).info };
          } catch (error) {
            // The source failed, or a frame could not be sent: the server still runs the
            // upload, so tell it to stop. The server stopped it itself after a drop or its
            // own error, and `cancel()` already told it.
            if (
              started &&
              !cancelled &&
              !stoppedByServer.has(error as object) &&
              !Disconnected.matches(error)
            ) {
              sendCancel(id);
            }

            throw error;
          } finally {
            stopWaiting = undefined;
            clearTimeout(noAnswer);
            if (running.get(id) === run) running.delete(id);
            helpers.lazyRelease();
          }
        }

        /**
         * Start once; start again on its own when the server says it no longer runs the upload.
         * Three tries in a row with no progress, and it gives up.
         */
        async function attemptUntilRunning(): Promise<{ info: unknown }> {
          for (let tries = 1; ; tries += 1) {
            const savedBefore = savedHigh;
            try {
              return await attempt();
            } catch (error) {
              const interrupted =
                UploadAborted.matches(error) && error.detail.reason === 'interrupted';
              if (savedHigh > savedBefore) tries = 0;

              if (!interrupted || tries >= 3 || cancelled) throw error;
            }
          }
        }

        return {
          id,
          start() {
            if (cancelled) return Promise.reject(UploadAborted({ reason: 'cancelled' }));

            if (result) return Promise.resolve(result);

            current ??= attemptUntilRunning().then(
              (value) => {
                result = value;
                current = undefined;
                return value;
              },
              (error: unknown) => {
                current = undefined;
                // A plugin's error comes back as `__<id>::code`; give the plugin its own code.
                throw unscopeErrorCode(event, error);
              },
            );
            return current;
          },
          cancel() {
            if (cancelled || result) return;

            cancelled = true;
            stopWaiting?.();
            deliver(id, { kind: 'error', error: UploadAborted({ reason: 'cancelled' }) });
            sendCancel(id);
          },
          onProgress(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        };
      }

      return {
        id: 'uploads',

        onIncoming(message) {
          const uploadId = message.metadata?.upload?.id;
          if (uploadId === undefined) return message;

          let event: UploadEvent;
          if (message.event === '__uploadAck__')
            event = { kind: 'ack', ack: message.payload as Ack };
          else if (message.event === '__uploadDone__') {
            event = {
              kind: 'done',
              info: (message.payload as { info: unknown } | null)?.info ?? null,
            };
          } else if (message.event === '__error__') {
            event = { kind: 'error', error: toLiveThingError(message.payload) };
          } else return message;

          // A frame for an upload that is not running here is late: drop it.
          if (!deliver(uploadId, event)) {
            helpers.log.info(`no running upload takes '${message.event}' for '${uploadId}'`);
          }

          return null;
        },

        onOpen: flushCancels,

        onClose() {
          for (const uploadId of running.keys()) deliver(uploadId, { kind: 'closed' });
        },

        install(socket) {
          binaryOf(socket).upload = create;
          // A plugin's scoped socket uploads too, under its `__<id>::` names. A channel
          // handle does not: uploads are not channel events.
          getAugmenters(socket).push((messaging, scope) => {
            if (!scope.prefixName || scope.markers().name !== undefined) return;

            // oxlint-disable-next-line max-params -- the same arguments as binary.upload
            binaryOf(messaging).upload = (
              event: string,
              input: unknown,
              source: UploadSource,
              options?: UploadOptions,
            ) => create(scopedName(scope, event), input, source, options);
          });
        },
      };
    },
  };
}

uploads.tag = 'uploads' as const;
