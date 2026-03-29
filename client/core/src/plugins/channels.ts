/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level channel routing requires `any` */
import { Plugin } from '@/plugins/base.ts';
import type { PluginHelpers } from '@/plugins/base.ts';
import type { Endpoint } from '@/endpoint.ts';
import type { TypeFn } from '@/plugins/types.ts';
import type { IncomingOf, OutgoingOf } from '@/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

/**
 * Given a contract with `channels`, produces a `channel(name)` method that
 * returns a typed Endpoint for that channel.
 */
export interface ChannelsTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { channels: infer C extends Record<string, any> }
    ? {
        channel<K extends keyof C & string>(
          name: K,
        ): Endpoint<IncomingOf<C[K]> & object, OutgoingOf<C[K]> & object>;
      }
    : {};
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
 * messages with a channel name.
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

  override install(socket: Record<string, unknown>, helpers: PluginHelpers) {
    socket.channel = (name: string) => this.createChannelEndpoint(name, helpers);
  }

  /**
   * Create a channel endpoint object with `on()` and `send()` methods
   * that route through this plugin.
   */
  private createChannelEndpoint(name: string, helpers: PluginHelpers): Record<string, unknown> {
    return {
      on: (event: string, handler: (data: unknown) => void) =>
        this.registerHandler(name, event, handler),
      send: (event: string, payload: unknown) => {
        const tagged = this.tagChannel(event, payload, name);
        helpers.rawSend(event, tagged);
        return true;
      },
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
