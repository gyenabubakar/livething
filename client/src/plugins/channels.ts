/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level channel routing requires `any` */
import { Plugin } from '~/plugins/base.ts';
import type { TypeFn } from '~/plugins/types.ts';
import type { ScopedApi } from '~/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

/**
 * Given a contract with `channels`, produces a `channel(name)` method that
 * returns a typed `ScopedEndpoint` for that channel — includes `on()`,
 * `send()`, `request()` (if the channel has requests), and `send.withAck()`
 * (if the channel has outgoing events).
 */
export interface ChannelsTypeFn extends TypeFn {
  readonly _api: ScopedApi<this['_contract'], 'channels', 'channel'>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for the Channels plugin. */
export interface ChannelsOptions {
  /** Buffer TTL for channel events. Number = all events, record = per-event. */
  ttl?: number | Record<string, number>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

type ChannelHandler = (data: unknown) => void;

/**
 * Routes incoming messages to channel-specific handlers and tags outgoing
 * messages with a channel name. Only owns `on()`, `send()`, and `_tag` on
 * endpoints. Other plugins (RequestResponse, Ack) wrap `socket.channel` in
 * their own `install()` to add `request()` and `send.withAck()`.
 *
 * Default: uses `_channel` field in the payload. Override `extractChannel`
 * and `tagChannel` to customize.
 */
export class Channels extends Plugin<ChannelsTypeFn, { channels: Record<string, any> }> {
  id = 'channels';

  private handlers = new Map<string, Map<string, Set<ChannelHandler>>>();
  readonly ttl: ChannelsOptions['ttl'];

  constructor(options?: ChannelsOptions) {
    super();
    this.ttl = options?.ttl;
  }

  override install(socket: Record<string, unknown>) {
    socket.channel = (name: string) => this.createChannelEndpoint(name);

    // _scopedKeys is a shared string[] on the socket object. Plugins that create
    // scoped endpoints (like Channels) register their key here. Other plugins
    // (RequestResponse, Ack) iterate this list during their install() to discover
    // scoped methods and wrap them with additional features (e.g., adding
    // `.request()` or `.send.withAck()` to channel endpoints).
    if (!socket._scopedKeys) socket._scopedKeys = [];
    (socket._scopedKeys as string[]).push('channel');
  }

  private createChannelEndpoint(name: string): Record<string, unknown> {
    const resolveTTL = (perCallTtl?: number): number | undefined => {
      if (perCallTtl !== undefined) return perCallTtl;
      if (typeof this.ttl === 'number') return this.ttl;
      if (typeof this.ttl === 'object') return this.ttl[name];
      return undefined;
    };

    return {
      on: (event: string, handler: (data: unknown) => void) => {
        this.helpers.lazyAcquire();
        const unregister = this.registerHandler(name, event, handler);
        return () => {
          unregister();
          this.helpers.lazyRelease();
        };
      },
      send: (event: string, payload: unknown, options?: { ttl?: number }) => {
        const tagged = this.tagChannel(event, payload, name);
        const ttl = resolveTTL(options?.ttl);
        return this.helpers.send(event, tagged, ttl !== undefined ? { ttl } : undefined);
      },
      // Generic tagging function exposed on the endpoint. Other plugins use it
      // to scope payloads (e.g., add `_channel`) before delegating to top-level
      // methods like `socket.request()` or `socket.send.withAck()`.
      _tag: (event: string, payload: unknown) => this.tagChannel(event, payload, name),
    };
  }

  /** Extract the channel name from an incoming message. Return `null` if not a channel message. */
  extractChannel(_event: string, payload: unknown): string | null {
    const p = payload as Record<string, unknown>;
    return typeof p._channel === 'string' ? p._channel : null;
  }

  /** Tag an outgoing message with a channel name. */
  tagChannel(_event: string, payload: unknown, channel: string): unknown {
    return { ...(payload as Record<string, unknown>), _channel: channel };
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const channel = this.extractChannel(message.event, message.payload);
    if (channel === null) return message;

    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) return message;

    const eventHandlers = channelHandlers.get(message.event);
    if (!eventHandlers) return message;

    for (const handler of eventHandlers) {
      handler(message.payload);
    }

    return null;
  }

  /** Register a handler for a channel event. Returns an unsubscribe function. */
  registerHandler(channel: string, event: string, handler: ChannelHandler): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Map());
    }
    const channelMap = this.handlers.get(channel)!;
    if (!channelMap.has(event)) {
      channelMap.set(event, new Set());
    }
    const handlerSet = channelMap.get(event)!;
    handlerSet.add(handler);

    return () => {
      handlerSet.delete(handler);
      if (handlerSet.size === 0) channelMap.delete(event);
      if (channelMap.size === 0) this.handlers.delete(channel);
    };
  }
}
