export { client } from '~/client.ts';
export { connect } from '~/connect.ts';
export type { ConnectOptions, ConnectDescriptor } from '~/connect.ts';

export { reconnection } from '~/primitives/reconnection/index.ts';
export type { ReconnectionOptions } from '~/primitives/reconnection/index.ts';
export { keepalive } from '~/primitives/keepalive/index.ts';
export type { KeepaliveOptions, QualityApi } from '~/primitives/keepalive/index.ts';
export { quality } from '~/primitives/quality.ts';
export type { QualityOptions } from '~/primitives/quality.ts';
export { buffering } from '~/primitives/buffering/index.ts';
export type { BufferingOptions } from '~/primitives/buffering/index.ts';
export { query } from '~/primitives/query.ts';
export type { QueryFn } from '~/primitives/query.ts';
export { serialization } from '~/primitives/serialization/index.ts';
export type {
  ParsedFrame,
  ArrayBufferSerialization,
  BlobSerialization,
} from '~/primitives/serialization/index.ts';
export { intercept } from '~/primitives/intercept.ts';
export type { InterceptFn } from '~/primitives/intercept.ts';
export { debug } from '~/primitives/debug.ts';
export { platform } from '~/primitives/platform.ts';
export type { PlatformOptions } from '~/primitives/platform.ts';
export { plugin } from '~/plugins/index.ts';
export type { PluginDef, PluginHooks, PluginFactory } from '~/plugins/index.ts';

export { namespaces } from '~/primitives/namespaces/index.ts';
export type { NamespacesOptions } from '~/primitives/namespaces/index.ts';
export { channels } from '~/primitives/channels/index.ts';
export type {
  ChannelsOptions,
  ChannelMessaging,
  ChannelMember,
  ScopeHandle,
  SubscribeSource,
} from '~/primitives/channels/index.ts';
export { requestResponse } from '~/primitives/request-response/index.ts';
export type { RequestResponseOptions } from '~/primitives/request-response/index.ts';
export { ack } from '~/primitives/ack/index.ts';
export type { AckOptions } from '~/primitives/ack/index.ts';
export { dedup } from '~/primitives/dedup.ts';
export type { DedupOptions } from '~/primitives/dedup.ts';
export { replay } from '~/primitives/replay.ts';
export { stream } from '~/primitives/stream/index.ts';
export type { StreamOptions, StreamTriggerOptions } from '~/primitives/stream/index.ts';

export { CloseCodes } from '@wskit/core';

export type { Socket, SocketConnection } from '~/socket/api.ts';
export type { CloseEvent } from '~/socket/socket.ts';
export type { Messaging, SendOptions } from '~/messaging.ts';
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
  ScopedMessaging,
  ScopedApi,
  StreamHandle,
  StreamHandlers,
  NudgesOf,
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
