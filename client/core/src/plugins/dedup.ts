import { Plugin } from '@/plugins/base.ts';

/** Options for the Dedup plugin. */
export interface DedupOptions {
  /** Time window in ms for tracking seen message IDs. Default: `60_000`. */
  windowMs?: number;
}

/**
 * Drops duplicate incoming messages within a time window.
 *
 * Default: uses `_messageId` field. Messages without an ID are always delivered.
 * Override `extractId` to customize.
 */
export class Dedup extends Plugin {
  id = 'dedup';

  private seen = new Map<string, number>();
  private readonly windowMs: number;

  constructor(options?: DedupOptions) {
    super();
    this.windowMs = options?.windowMs ?? 60_000;
  }

  /** Extract a unique message ID from the payload. Return `null` to skip dedup. */
  extractId(_event: string, payload: unknown): string | null {
    const p = payload as Record<string, unknown>;
    return typeof p._messageId === 'string' ? p._messageId : null;
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const id = this.extractId(message.event, message.payload);
    if (id === null) return message;

    const now = Date.now();
    this.cleanup(now);

    if (this.seen.has(id)) return null;

    this.seen.set(id, now);
    return message;
  }

  private cleanup(now: number): void {
    for (const [id, timestamp] of this.seen) {
      if (now - timestamp > this.windowMs) {
        this.seen.delete(id);
      }
    }
  }
}
