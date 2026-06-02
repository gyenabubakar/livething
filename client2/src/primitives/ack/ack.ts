import { Disconnected, Timeout } from '~/errors.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { getAugmenters } from '~/internal/scoped.ts';
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
 */
export function ack(options: AckOptions = {}): Primitive<AckTypeFn> {
  const defaultTimeout = options.timeout ?? 10_000;

  return {
    _tag: 'ack',
    setup(helpers) {
      const pending = new Map<string, Pending>();

      function sendWithAck(
        event: string,
        payload: unknown,
        opts: AckOptionsArg & { markers: ScopeMarkers },
      ): Promise<void> {
        const ackId = helpers.generateId('ack');
        helpers.lazyAcquire();

        return new Promise<void>((resolve, reject) => {
          function done(): void {
            pending.delete(ackId);
            helpers.lazyRelease();
          }
          const timer = setTimeout(() => {
            done();
            reject(Timeout());
          }, opts.timeout ?? defaultTimeout);

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

          helpers.send(
            { event, payload, __wskit: { ackId, ...opts.markers } },
            opts.ttl !== undefined ? { ttl: opts.ttl } : undefined,
          );
        });
      }

      return {
        id: 'ack',
        onIncoming(message) {
          const ackId = message.__wskit?.ackId;
          if (typeof ackId !== 'string') return message;

          const waiter = pending.get(ackId);
          if (!waiter) return message;

          helpers.log.info(`matched acknowledgement '${ackId}'`);
          if (message.event === '__error__') waiter.reject(toWSKitError(message.payload));
          else waiter.resolve();
          return null;
        },
        onClose() {
          for (const waiter of pending.values()) waiter.reject(Disconnected());
          pending.clear();
        },
        install(socket) {
          // @ts-expect-error — install adds sendWithAck() to the socket dynamically
          socket.sendWithAck = (event: string, payload: unknown, opts?: AckOptionsArg) =>
            sendWithAck(event, payload, { ...opts, markers: {} });

          getAugmenters(socket).push((endpoint, scope) => {
            endpoint.sendWithAck = (event: string, payload: unknown, opts?: AckOptionsArg) => {
              scope.assertReady?.();
              return sendWithAck(event, payload, { ...opts, markers: scope.markers() });
            };
          });
        },
      };
    },
  };
}
