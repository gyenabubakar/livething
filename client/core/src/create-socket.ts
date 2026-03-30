/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin type merging requires `any` */
import { Socket } from '@/socket/socket.ts';
import type { FullSocketOptions } from '@/options.ts';
import type { Plugin, PluginHelpers } from '@/plugins/base.ts';
import type { ApplyPlugins, ValidatePlugins } from '@/plugins/types.ts';
import type { Simplify, SocketContract } from '@/types.ts';

/**
 * Create a typed WebSocket client.
 *
 * Constructs a `Socket`, wires up plugins (sets `helpers`, calls `install`),
 * and returns the socket with plugin APIs merged onto the type.
 *
 * ```ts
 * const socket = createSocket<MySocket>('wss://example.com/ws', {
 *   adapter: new Adapter(),
 *   plugins: [new Channels(), new RequestResponse()],
 * });
 * ```
 */
export function createSocket<
  TContract extends SocketContract,
  const TPlugins extends readonly Plugin<any, any>[] = [],
>(
  url: string | (() => string | Promise<string>),
  options?: FullSocketOptions<TContract> & {
    plugins?: ValidatePlugins<TContract, TPlugins> & TPlugins;
  },
): Simplify<Socket<TContract> & ApplyPlugins<TPlugins, TContract>> {
  const opts = (options ?? {}) as FullSocketOptions<TContract>;
  const plugins = (opts.plugins ?? []) as readonly Plugin<any, any>[];

  const socket = new Socket<TContract>(url, opts, plugins);

  // Shared monotonic counter for plugin ID generation. All plugins on this
  // socket share the same closure, so IDs from different plugins (e.g.,
  // "ack-1", "req-2", "ack-3") never collide.
  let idCounter = 0;

  // helpers is constructed once, before the plugin loop, so every plugin
  // receives the same object. This is important because plugins installed
  // later (e.g., Ack) may need helpers methods that reference the socket,
  // and the socket is already created at this point.
  const helpers: PluginHelpers = {
    rawSend(event: string, payload: unknown) {
      socket._rawSend(event, payload);
    },
    generateId(prefix?: string) {
      const id = ++idCounter;
      return prefix ? `${prefix}-${id}` : `${id}`;
    },
    getState() {
      return socket.getState();
    },
    getOptions() {
      return Object.freeze({ ...opts });
    },
    ensureConnected() {
      socket._ensureConnected();
    },
    send(event: string, payload: unknown, options?: { ttl?: number }) {
      return socket._send(event, payload, options);
    },
    lazyAcquire() {
      socket._lazyAcquire();
    },
    lazyRelease() {
      socket._lazyRelease();
    },
  };

  // Wire up each plugin: set helpers, then let it attach its methods.
  // Order matters: Channels must install before Ack and RequestResponse,
  // because those plugins read _scopedKeys (populated by Channels.install())
  // to wrap channel endpoints with .withAck() and .request().
  for (const plugin of plugins) {
    plugin.helpers = helpers;
    plugin.install?.(socket as unknown as Record<string, unknown>);
  }

  return socket as unknown as Simplify<Socket<TContract> & ApplyPlugins<TPlugins, TContract>>;
}
