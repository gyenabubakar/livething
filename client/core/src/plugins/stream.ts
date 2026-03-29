/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level stream routing requires `any` */
import { Plugin } from '@/plugins/base.ts';
import type { TypeFn } from '@/plugins/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

export interface StreamTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { incoming: infer I extends Record<string, any> }
    ? {
        onStream<K extends keyof I & string>(
          event: K,
          handlers: {
            onChunk: (chunk: I[K], streamId: string) => void;
            onEnd?: (streamId: string) => void;
            onTimeout?: (streamId: string) => void;
          },
        ): () => void;
      }
    : {};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StreamOptions {
  /** Max time in ms an incomplete stream can remain open. Default: `30_000`. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamHandlers {
  onChunk: (chunk: unknown, streamId: string) => void;
  onEnd?: (streamId: string) => void;
  onTimeout?: (streamId: string) => void;
}

interface ActiveStream {
  handlers: StreamHandlers;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Tracks streaming/chunked messages grouped by a stream ID. Each chunk is
 * a regular incoming message tagged with a stream identifier. The plugin
 * groups them and provides lifecycle callbacks.
 *
 * Default: uses `_streamId` field for identification, `_streamEnd: true`
 * for end-of-stream. Override `extractStreamId` and `isStreamEnd` to customize.
 *
 * Routing: `on()` and `onStream()` both fire for stream messages. The plugin
 * observes via `onIncoming` but does NOT consume (does not return `null`).
 */
export class Stream extends Plugin<StreamTypeFn> {
  id = 'stream';

  private streams = new Map<string, ActiveStream>();
  private subscriptions = new Map<string, Set<StreamHandlers>>();
  readonly defaultTimeout: number;

  constructor(options?: StreamOptions) {
    super();
    this.defaultTimeout = options?.timeout ?? 30_000;
  }

  /** Extract a stream ID from the payload. Return `null` if not a stream message. */
  extractStreamId(_event: string, payload: unknown): string | null {
    const p = payload as Record<string, unknown>;
    return typeof p._streamId === 'string' ? p._streamId : null;
  }

  /** Check if this message marks the end of a stream. */
  isStreamEnd(_event: string, payload: unknown): boolean {
    const p = payload as Record<string, unknown>;
    return p._streamEnd === true;
  }

  /**
   * Register stream handlers for an event. Called by the socket when
   * `socket.onStream()` is invoked. Returns an unsubscribe function.
   */
  registerStream(event: string, handlers: StreamHandlers): () => void {
    if (!this.subscriptions.has(event)) {
      this.subscriptions.set(event, new Set());
    }
    this.subscriptions.get(event)!.add(handlers);

    return () => {
      const subs = this.subscriptions.get(event);
      if (subs) {
        subs.delete(handlers);
        if (subs.size === 0) this.subscriptions.delete(event);
      }
    };
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const streamId = this.extractStreamId(message.event, message.payload);
    if (streamId === null) return message;

    const subs = this.subscriptions.get(message.event);
    if (!subs || subs.size === 0) return message;

    const isEnd = this.isStreamEnd(message.event, message.payload);

    if (!this.streams.has(streamId)) {
      for (const handlers of subs) {
        const timer = setTimeout(() => {
          this.streams.delete(streamId);
          handlers.onTimeout?.(streamId);
        }, this.defaultTimeout);

        this.streams.set(streamId, { handlers, timer });
      }
    }

    for (const handlers of subs) {
      handlers.onChunk(message.payload, streamId);
    }

    if (isEnd) {
      const active = this.streams.get(streamId);
      if (active) {
        clearTimeout(active.timer);
        this.streams.delete(streamId);
      }
      for (const handlers of subs) {
        handlers.onEnd?.(streamId);
      }
    }

    return message;
  }

  override onClose(_code: number, _reason: string) {
    for (const [streamId, active] of this.streams) {
      clearTimeout(active.timer);
      active.handlers.onTimeout?.(streamId);
    }
    this.streams.clear();
  }
}
