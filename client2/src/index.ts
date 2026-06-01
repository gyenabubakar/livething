export { client } from '~/client.ts';
export { connect } from '~/connect.ts';
export type { ConnectOptions, ConnectDescriptor } from '~/connect.ts';

export { reconnection } from '~/primitives/reconnection.ts';
export type { ReconnectionOptions } from '~/primitives/reconnection.ts';
export { keepalive } from '~/primitives/keepalive/index.ts';
export type { KeepaliveOptions } from '~/primitives/keepalive/index.ts';
export { quality } from '~/primitives/quality.ts';
export type { QualityOptions } from '~/primitives/quality.ts';
export { buffering } from '~/primitives/buffering/index.ts';
export type { BufferingOptions } from '~/primitives/buffering/index.ts';
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

export { namespaces } from '~/primitives/namespaces.ts';
export type { NamespacesOptions } from '~/primitives/namespaces.ts';
export { requestResponse } from '~/primitives/request-response.ts';
export type { RequestResponseOptions } from '~/primitives/request-response.ts';
export { ack } from '~/primitives/ack.ts';
export type { AckOptions } from '~/primitives/ack.ts';
export { dedup } from '~/primitives/dedup.ts';
export type { DedupOptions } from '~/primitives/dedup.ts';
export { replay } from '~/primitives/replay.ts';

export { CloseCodes } from '@wskit/core';

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

// For people writing their own primitives.
export type {
  TypeFn,
  EmptyTypeFn,
  Apply,
  Primitive,
  ApplyPrimitives,
  ValidatePrimitives,
  SocketWithPrimitives,
} from '~/primitives/types.ts';
