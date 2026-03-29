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

export { Plugin } from '@/plugins/base.ts';
export type {
  TypeFn,
  Apply,
  ApplyPlugins,
  ValidatePlugins,
  SocketWithPlugins,
} from '@/plugins/types.ts';
