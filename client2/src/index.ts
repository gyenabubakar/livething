// Core composition API
export { client } from '~/client.ts';
export { connect } from '~/connect.ts';
export type { ConnectOptions, ConnectDescriptor } from '~/connect.ts';

// Connection & message primitives
export { reconnection } from '~/primitives/reconnection.ts';
export type { ReconnectionOptions } from '~/primitives/reconnection.ts';
export { keepalive } from '~/primitives/keepalive.ts';
export type { KeepaliveOptions } from '~/primitives/keepalive.ts';
export { quality } from '~/primitives/quality.ts';
export type { QualityOptions } from '~/primitives/quality.ts';
export { buffering } from '~/primitives/buffering.ts';
export type { BufferingOptions } from '~/primitives/buffering.ts';
export { query } from '~/primitives/query.ts';
export type { QueryFn } from '~/primitives/query.ts';
export { serialization } from '~/primitives/serialization.ts';
export type {
  ParsedFrame,
  ArrayBufferSerialization,
  BlobSerialization,
} from '~/primitives/serialization.ts';
export { intercept } from '~/primitives/intercept.ts';
export type { InterceptFn } from '~/primitives/intercept.ts';
export { debug } from '~/primitives/debug.ts';

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
