import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `dedup()`. */
export interface DedupOptions {
  /** How long to remember a message id, in ms. Default: `60_000`. */
  windowMs?: number;
  /**
   * Most ids to remember at once. Stops a flood of unique ids (e.g. a reconnect
   * catch-up) from growing the set without limit inside the window. When passed,
   * the oldest ids are dropped. Default: `10_000`.
   */
  maxSize?: number;
}

/**
 * Drops a message you've already seen. When a connection drops and the server
 * replays what you missed, some messages can arrive twice; this throws away the
 * repeat. It only looks at messages that carry a `__wskit.messageId`; anything
 * without one always goes through.
 */
export function dedup(options: DedupOptions = {}): Primitive<EmptyTypeFn> {
  const windowMs = options.windowMs ?? 60_000;
  const maxSize = options.maxSize ?? 10_000;

  return {
    _tag: 'dedup',
    setup(helpers) {
      const seen = new Map<string, number>();

      return {
        id: 'dedup',
        onIncoming(message) {
          const id = message.__wskit?.messageId;
          if (typeof id !== 'string') return message;

          const now = Date.now();
          // Forget ids older than the window. The map keeps insertion order, so
          // the oldest are first and we can stop at the first still-fresh one.
          for (const [key, time] of seen) {
            if (now - time <= windowMs) break;
            seen.delete(key);
          }

          if (seen.has(id)) {
            helpers.log.info(`dropped duplicate '${message.event}' (messageId ${id})`);
            return null;
          }
          seen.set(id, now);
          // Bound memory during a unique-id burst the time window can't prune
          // (all ids still fresh). Rebuild to the newest half rather than
          // deleting the oldest key on every insert: repeated front deletes
          // leave gaps the prune scan above then walks on every call — a
          // pathological slowdown. This runs about once per maxSize/2 inserts.
          if (seen.size > maxSize) {
            const keep = maxSize >> 1;
            const entries = [...seen];
            seen.clear();
            for (let i = entries.length - keep; i < entries.length; i++) {
              seen.set(entries[i]![0], entries[i]![1]);
            }
          }
          return message;
        },
      };
    },
  };
}
