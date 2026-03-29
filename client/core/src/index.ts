export type {
  SocketContract,
  ChannelContract,
  RequestContract,
  ConnectionState,
  ConnectionQuality,
  IncomingOf,
  OutgoingOf,
  ChannelsOf,
  RequestsOf,
  Requires,
  Simplify,
  StaticApi,
} from '@/types.ts';

export type { Endpoint, SendOptions } from '@/endpoint.ts';

export { PlatformAdapter } from '@/adapter.ts';
export type { VisibilityState, NetworkState } from '@/adapter.ts';

export type { MiddlewareFn, MiddlewareMessage } from '@/middleware.ts';

export { Socket } from '@/socket/index.ts';
export { createSocket } from '@/create-socket.ts';
export type { CloseEvent } from '@/socket/index.ts';
export type { SocketOptions, FullSocketOptions } from '@/options.ts';

export { Plugin } from '@/plugins/base.ts';
export type { PluginHelpers } from '@/plugins/base.ts';
export type {
  TypeFn,
  Apply,
  ApplyPlugins,
  ValidatePlugins,
  SocketWithPlugins,
} from '@/plugins/types.ts';
