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

  // Shared monotonic counter for plugin ID generation
  let idCounter = 0;

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
  };

  // Wire up each plugin: set helpers, then let it attach its methods
  for (const plugin of plugins) {
    plugin.helpers = helpers;
    plugin.install?.(socket as unknown as Record<string, unknown>);
  }

  return socket as unknown as Simplify<Socket<TContract> & ApplyPlugins<TPlugins, TContract>>;
}
