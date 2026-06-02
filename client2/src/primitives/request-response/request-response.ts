import { Disconnected, Timeout } from '~/errors.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { getAugmenters } from '~/internal/scoped.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type {
  RequestResponseOptions,
  RequestResponseTypeFn,
} from '~/primitives/request-response/types.ts';
import type { Primitive } from '~/primitives/types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Turns the usual one-way send into ask-and-wait: `socket.request(...)` sends a
 * message tagged with a unique id and returns a promise that resolves when the
 * server replies to that exact message. The promise rejects on timeout, on a
 * typed server error, or if you disconnect while waiting.
 */
export function requestResponse(
  options: RequestResponseOptions = {},
): Primitive<RequestResponseTypeFn> {
  const defaultTimeout = options.timeout ?? 10_000;

  return {
    _tag: 'requestResponse',
    setup(helpers) {
      const pending = new Map<string, Pending>();

      function sendRequest(
        event: string,
        payload: unknown,
        opts: { markers: ScopeMarkers; timeout?: number },
      ): Promise<unknown> {
        const correlationId = helpers.generateId('req');
        helpers.lazyAcquire();
        helpers.ensureConnected();

        return new Promise((resolve, reject) => {
          function done(): void {
            pending.delete(correlationId);
            helpers.lazyRelease();
          }
          const timer = setTimeout(() => {
            done();
            reject(Timeout());
          }, opts.timeout ?? defaultTimeout);

          pending.set(correlationId, {
            resolve: (value) => {
              clearTimeout(timer);
              done();
              resolve(value);
            },
            reject: (reason) => {
              clearTimeout(timer);
              done();
              reject(reason);
            },
          });

          helpers.rawSend({ event, payload, __wskit: { correlationId, ...opts.markers } });
        });
      }

      return {
        id: 'requestResponse',
        onIncoming(message) {
          const correlationId = message.__wskit?.correlationId;
          if (typeof correlationId !== 'string') return message;
          const waiter = pending.get(correlationId);
          if (!waiter) return message;

          helpers.log.info(`matched response for request '${correlationId}'`);
          if (message.event === '__error__') waiter.reject(toWSKitError(message.payload));
          else waiter.resolve(message.payload);
          return null;
        },
        onClose() {
          for (const waiter of pending.values()) waiter.reject(Disconnected());
          pending.clear();
        },
        install(socket) {
          // @ts-expect-error — install adds request() to the socket dynamically
          socket.request = (event: string, payload: unknown, opts?: { timeout?: number }) =>
            sendRequest(event, payload, { markers: {}, timeout: opts?.timeout });

          // Let namespace/channel endpoints make scoped requests too.
          getAugmenters(socket).push((endpoint, scope) => {
            endpoint.request = (event: string, payload: unknown, opts?: { timeout?: number }) => {
              scope.assertReady?.();
              return sendRequest(event, payload, {
                markers: scope.markers(),
                timeout: opts?.timeout,
              });
            };
          });
        },
      };
    },
  };
}
