import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `dedup()`. */
export interface DedupOptions {
  /** How long to keep remembering a message id after it was last seen, in ms. Default: `60_000`. */
  windowMs?: number;
}

/**
 * Drops a message you've already seen. When a connection drops and the server
 * replays what you missed, some messages can arrive twice; this throws away the
 * repeat. It only looks at messages that carry `metadata.delivery.id`; anything
 * without one always goes through.
 */
export function dedup(options: DedupOptions = {}): Primitive<EmptyTypeFn> {
  const windowMs = options.windowMs ?? 60_000;

  return {
    _tag: 'dedup',
    setup(helpers) {
      const seen = new Map<string, number>();

      return {
        id: 'dedup',

        onIncoming(message) {
          const id = message.metadata?.delivery?.id;
          if (typeof id !== 'string') return message;

          const now = Date.now();
          // Forget ids older than the window. The map keeps insertion order, so
          // the oldest are first and we can stop at the first still-fresh one.
          for (const [key, time] of seen) {
            if (now - time <= windowMs) break;

            seen.delete(key);
          }

          if (seen.has(id)) {
            helpers.log.info(`dropped duplicate '${message.event}' (delivery id ${id})`);
            // Sliding window: refresh the timestamp so an id stays remembered as
            // long as repeats keep arriving. delete + set moves it to the end, so
            // the oldest-first eviction order above stays correct.
            seen.delete(id);
            seen.set(id, now);
            return null;
          }

          seen.set(id, now);

          return message;
        },
      };
    },
  };
}

dedup.tag = 'dedup';
