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
 * - **Outgoing** — every server-to-client message is stamped with a unique
 *   `_messageId` so the client can spot and discard duplicates from replays
 *   or reconnects.
 * - **Incoming** — the engine remembers the most recent `_messageId` values
 *   the client has sent (default 256 per connection) and silently drops any
 *   frame whose id is already in the window. This protects handlers from
 *   duplicate runs caused by client-side retries on a flaky socket.
 *
 * Clients opt in to incoming dedup by attaching a stable `_messageId` to
 * retried sends. Messages without a `_messageId` are always dispatched.
 *
 * @example
 * ```ts
 * server('chat').dedup();
 * ```
 */
export function dedup(): DedupPrimitive {
  return {
    __wskit: 'dedup',
    __kind: 'infrastructure',
    __identity: [DEDUP_KEY],
    __dependencies: [],
    __requires: {},
    __setup(engine) {
      engine.installOnce(DEDUP_KEY, () => {
        engine.enableIncomingDedup(DEDUP_DEFAULT_INCOMING_CAP);

        engine.onOutgoing((message) => {
          // Skip internal protocol events (e.g. `_ack`, `_replay`).
          if (isProtocolEvent(message.event)) return;

          return {
            event: message.event,
            payload: {
              ...(message.payload as Record<string, unknown>),
              _messageId: engine.generateId('msg'),
            },
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
