import { Disconnected, Timeout } from '~/errors.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import { wireIdError } from '~/internal/wire-validation.ts';
import type { FrameOwner, SendResult, WireMessage } from '~/internal/runtime.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { AckOptions, AckTypeFn } from '~/primitives/ack/types.ts';
import type { Primitive } from '~/primitives/types.ts';

interface Pending {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

type AckOptionsArg = { timeout?: number; ttl?: number };

/**
 * Lets you confirm the server received a message. `socket.sendWithAck(...)`
 * works like `send()` but returns a promise that resolves once the server sends
 * back its "got it." Unlike `request()`, you don't get data back — just
 * confirmation. The promise rejects on timeout, a typed error, or disconnect.
 *
 * Call it while the socket is open or connecting. On a non-lazy socket that you
 * have not `connect()`ed yet (state `closed`), it rejects at once with
 * `disconnected` — a lazy socket connects on first use, and `buffering()` holds
 * sends made while offline.
 */
export function ack(options: AckOptions = {}): Primitive<AckTypeFn> {
  const defaultTimeout = options.timeout ?? 10_000;

  return {
    _tag: 'ack',

    // Run after serverRequest so a server-initiated request is claimed there
    // first; this primitive then only sees acks for the client's own sends.
    optionalAfter: ['serverRequest'],

    setup(helpers) {
      const pending = new Map<string, Pending>();

      // Frames for acks made before the socket is open (lazy connect / reconnect)
      // when no buffering is installed to hold them. Flushed on onOpen — same as
      // request() — so a sendWithAck() started before open isn't dropped. Each
      // carries its owner so a serialization failure on flush rejects that ack.
      const outbox = new Map<string, { message: WireMessage; owner: FrameOwner }>();

      function ownerFor(ackId: string): FrameOwner {
        return {
          isPending: () => pending.has(ackId),
          reject: (error) => pending.get(ackId)?.reject(error),
        };
      }

      function sendWithAck(
        event: string,
        payload: unknown,
        callOptions: AckOptionsArg & { markers: ScopeMarkers },
      ): Promise<void> {
        const eventError = wireIdError(event, event, 'event');
        if (eventError) return Promise.reject(eventError);

        const ackId = helpers.generateId('ack');
        helpers.lazyAcquire();
        helpers.ensureConnected();

        return new Promise<void>((resolve, reject) => {
          function done(): void {
            pending.delete(ackId);
            outbox.delete(ackId);
            helpers.lazyRelease();
          }

          const timer = setTimeout(() => {
            done();
            reject(Timeout());
          }, callOptions.timeout ?? defaultTimeout);

          pending.set(ackId, {
            resolve: () => {
              clearTimeout(timer);
              done();
              resolve();
            },

            reject: (reason) => {
              clearTimeout(timer);
              done();
              reject(reason);
            },
          });

          const frame: WireMessage = { event, payload, __wskit: { ackId, ...callOptions.markers } };
          const owner = ownerFor(ackId);
          let result: SendResult;

          try {
            result = helpers.send(frame, {
              owner,
              ...(callOptions.ttl !== undefined ? { ttl: callOptions.ttl } : {}),
            });
          } catch (error) {
            // A throwing send must still tear down the timer, pending, and hold.
            clearTimeout(timer);
            done();
            reject(error);
            return;
          }

          if (result === 'connecting') {
            outbox.set(ackId, { message: frame, owner });
          } else if (result === 'closed' || result === 'blocked') {
            clearTimeout(timer);
            done();
            reject(Disconnected());
          }
        });
      }

      return {
        id: 'ack',

        onOpen() {
          const entries = [...outbox.values()];
          outbox.clear();
          for (const { message, owner } of entries) {
            if (owner.isPending()) helpers.rawSend(message, owner);
          }
          return null;
        },

        onIncoming(message) {
          const ackId = message.__wskit?.ackId;
          if (typeof ackId !== 'string') return message;

          // An `__ack__` (or correlated `__error__`) frame is the server's
          // RECEIPT of one of our client `sendWithAck` sends. Settle the matching
          // waiter; a stale id (already settled, or arrived after timeout) is
          // swallowed — never forwarded to a user handler.
          if (message.event === '__ack__' || message.event === '__error__') {
            const waiter = pending.get(ackId);
            if (!waiter) return null;

            helpers.log.info(`matched acknowledgement '${ackId}'`);

            if (message.event === '__error__') waiter.reject(toWSKitError(message.payload));
            else waiter.resolve();

            return null;
          }

          // A normal user-event frame carrying an `ackId` is a SERVER-initiated
          // sendWithAck asking us to confirm receipt. Auto-send the `__ack__`
          // receipt (no app code needed), then pass the message through so the
          // app's `on(event)` handler still runs.
          helpers.log.info(`auto-confirming server send '${ackId}'`);
          helpers.rawSend({ event: '__ack__', payload: {}, __wskit: { ackId } });

          return message;
        },

        onClose() {
          // Each reject() runs done(), which deletes its own entry, so the map
          // empties itself as we go.
          for (const waiter of pending.values()) waiter.reject(Disconnected());
          outbox.clear();
        },

        install(socket) {
          // @ts-expect-error — install adds sendWithAck() to the socket dynamically
          socket.sendWithAck = (event: string, payload: unknown, callOptions?: AckOptionsArg) =>
            sendWithAck(event, payload, { ...callOptions, markers: {} });

          getAugmenters(socket).push((messaging, scope) => {
            messaging.sendWithAck = (
              event: string,
              payload: unknown,
              callOptions?: AckOptionsArg,
            ) => {
              scope.assertReady?.();
              return sendWithAck(event, payload, { ...callOptions, markers: scope.markers() });
            };
          });
        },
      };
    },
  };
}

ack.tag = 'ack';
