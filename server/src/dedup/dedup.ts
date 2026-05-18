import { isProtocolEvent } from '~/_engine/compile/utils.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `dedup()`. */
export interface DedupPrimitive extends Primitive<'dedup'> {}

/** @internal */
const DEDUP_KEY = Symbol('dedup');

/**
 * The default number of recent incoming `_messageId` values remembered per
 * connection. Chosen to cover realistic burst retry scenarios (a few seconds
 * of client retries under flaky networks) without growing memory unbounded.
 */
const DEDUP_DEFAULT_INCOMING_CAP = 256;

/**
 * Deduplicates messages in both directions:
 *
 * - **Outgoing** — every server-to-client message is stamped with a unique id
 *   so clients can detect and drop duplicates from replays or reconnects.
 * - **Incoming** — duplicate sends from a client are silently dropped before
 *   handlers run, protecting them from client-side retries on a flaky socket.
 *
 * Clients opt in to incoming dedup by attaching a stable id to retried sends.
 * Sends without an id are always dispatched.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withDedup } from '@wskit/server/dedup';
 *
 * withDedup(server('chat')).dedup();
 * ```
 */
export function dedup(): DedupPrimitive {
  return {
    __wskit: 'dedup',
    __kind: 'infrastructure',
    __identity: [DEDUP_KEY],
    __requires: {},
    __setup(engine) {
      engine.installOnce(DEDUP_KEY, () => {
        engine.enableIncomingDedup(DEDUP_DEFAULT_INCOMING_CAP);

        engine.onOutgoing((message) => {
          // Skip internal protocol events (e.g. `_ack`, `_replay`).
          if (isProtocolEvent(message.event)) return;

          return {
            ...(message.payload as Record<string, unknown>),
            _messageId: engine.generateId('msg'),
          };
        });
      });
    },
  };
}

/**
 * The identity of the `dedup` primitive. Pass `dedup` itself in a module's
 * `dependencies` array to declare that it must be registered.
 */
dedup.__key = DEDUP_KEY;
