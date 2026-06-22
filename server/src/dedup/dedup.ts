import { assertPositiveInteger } from '~/_engine/validation.ts';
import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `dedup()`. */
export interface DedupPrimitive extends Primitive<'dedup'> {}

/** @internal */
const DEDUP_KEY = Symbol('dedup');

/**
 * The default number of recent incoming `messageId` values remembered per
 * connection. Chosen to cover realistic burst retry scenarios (a few seconds
 * of client retries under flaky networks) without growing memory unbounded.
 */
const DEDUP_DEFAULT_INCOMING_CAP = 256;

/**
 * Deduplicates messages in both directions:
 *
 * - **Outgoing** — every server-to-client message gets a unique id so clients
 *   can drop duplicates from replays or reconnects.
 * - **Incoming** — duplicate sends from a client are dropped before handlers
 *   run, protecting against client-side retries on a flaky socket. Clients
 *   opt in by attaching a stable id; sends without an id always go through.
 *
 * Enable this via `dedup: true` on the contract config instead of calling
 * this primitive directly.
 */
export function dedup(options?: { cap?: number }): DedupPrimitive {
  if (options?.cap !== undefined) {
    assertPositiveInteger(options.cap, 'cap', 'dedup()');
  }
  const cap = options?.cap ?? DEDUP_DEFAULT_INCOMING_CAP;

  return {
    __wskit: 'dedup',
    __kind: 'infrastructure',
    __identity: [DEDUP_KEY],
    __requires: {},
    __setup(engine) {
      engine.installOnce(DEDUP_KEY, () => {
        engine.enableIncomingDedup(cap);

        // Stamp `messageId` into every outgoing user frame's `__wskit`. The
        // pipeline already skips protocol frames before calling stampers.
        engine.onWSKitStamp(() => ({ messageId: engine.generateId('msg') }));
      });
    },
  };
}

/**
 * The identity of the `dedup` primitive. Pass `dedup` itself in a plugin's
 * `dependencies` array to declare that it must be registered.
 */
dedup.__key = DEDUP_KEY;
