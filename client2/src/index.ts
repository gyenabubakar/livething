// Core composition API
export { client } from '~/client.ts';
export { connect } from '~/connect.ts';
export type { ConnectOptions, ConnectDescriptor } from '~/connect.ts';

// Re-exported from @wskit/core for convenience
export { CloseCodes } from '@wskit/core';

// Public types
export type { Socket, SocketConnection } from '~/socket/api.ts';
export type { CloseEvent } from '~/socket/socket.ts';
export type { Endpoint, SendOptions } from '~/endpoint.ts';
export type {
  SocketContract,
  ScopeContract,
  ChannelContract,
  RequestContract,
  StreamContract,
  ConnectionState,
  ConnectionQuality,
  IncomingOf,
  OutgoingOf,
  NamespacesOf,
  ChannelsOf,
  StreamsOf,
  RequestsOf,
  ErrorsOf,
  Requires,
  Simplify,
  StaticApi,
  RequestMethod,
  ScopedEndpoint,
  ScopedApi,
} from '~/types.ts';

// Primitive authoring types
export type {
  TypeFn,
  EmptyTypeFn,
  Apply,
  PrimitiveDescriptor,
  PrimitiveSpec,
  ApplyPrimitives,
  ValidatePrimitives,
  SocketWithPrimitives,
} from '~/primitives/types.ts';
