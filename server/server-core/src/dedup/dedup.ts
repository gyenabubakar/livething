import { isProtocolEvent } from '~/_engine/compile/utils.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `dedup()`. */
export interface DedupPrimitive extends Primitive<'dedup'> {}

/** @internal */
const DEDUP_KEY = Symbol('dedup');

/**
 * Tags every outgoing message with a unique ID so the client can detect and
 * discard duplicates that may arrive from a replay, retry, or network hiccup.
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
