export { client } from '~/client.ts';
export { connect } from '~/connect.ts';
export type { ConnectOptions, ConnectDescriptor } from '~/connect.ts';
export { websocket } from '~/transports/websocket.ts';
export { http } from '~/transports/http.ts';
export type {
  Transport,
  TransportEvents,
  TransportFactory,
  TransportName,
  TransportOpenOptions,
} from '~/transports/transport.ts';

export { reconnection } from '~/primitives/reconnection/index.ts';
export type {
  ReconnectionApi,
  ReconnectionInfo,
  ReconnectionOptions,
} from '~/primitives/reconnection/index.ts';
export { keepalive } from '~/primitives/keepalive/index.ts';
export type { KeepaliveOptions, QualityApi } from '~/primitives/keepalive/index.ts';
export { buffering } from '~/primitives/buffering/index.ts';
export type { BufferingOptions } from '~/primitives/buffering/index.ts';
export { intercept } from '~/primitives/intercept.ts';
export type { InterceptFn } from '~/primitives/intercept.ts';
export { platform } from '~/primitives/platform.ts';
export type { PlatformApi, PlatformOptions } from '~/primitives/platform.ts';
export { plugin } from '~/plugins/index.ts';
export type {
  PluginDef,
  PluginInstance,
  PluginFactory,
  PrimitiveFactory,
  PluginSocket,
  PluginBase,
  PluginSlice,
  TopLevelContract,
} from '~/plugins/index.ts';

export { channels } from '~/primitives/channels/index.ts';
export type {
  ChannelMessaging,
  ChannelMember,
  ChannelStatus,
  FamilyHandle,
  SubscribeSource,
} from '~/primitives/channels/index.ts';
export { clientRequests } from '~/primitives/client-requests/index.ts';
export type { ClientRequestsOptions } from '~/primitives/client-requests/index.ts';
export { serverRequests } from '~/primitives/server-requests/index.ts';
export { dedup } from '~/primitives/dedup.ts';
export type { DedupOptions } from '~/primitives/dedup.ts';
export { replay } from '~/primitives/replay.ts';
export { gaps } from '~/primitives/gaps.ts';
export type { GapsApi, GapsChannelTypeFn, GapsPrimitive, GapsTypeFn } from '~/primitives/gaps.ts';
export { inbox, readReceipts } from '~/primitives/inbox/index.ts';
export type {
  ChannelInboxApi,
  ChannelReadReceiptsApi,
  CursorList,
  InboxOptions,
  ReceiptQueryOptions,
  ReadReceiptsOptions,
} from '~/primitives/inbox/index.ts';
export { stream } from '~/primitives/stream/index.ts';
export { binary } from '~/primitives/binary/index.ts';
export type {
  BinaryAnswer,
  BinaryItem,
  BinaryMessaging,
  BinaryOptions,
} from '~/primitives/binary/index.ts';
export { uploads } from '~/primitives/uploads/index.ts';
export type { Upload, UploadOptions, UploadSource } from '~/primitives/uploads/index.ts';
export type { StreamOptions, StreamTriggerOptions } from '~/primitives/stream/index.ts';

export { CloseCodes } from '@livething/core';
export type {
  LiveThingChannelMetadata,
  LiveThingDeliveryMetadata,
  LiveThingExchangeMetadata,
  LiveThingMetadata,
  LiveThingStreamMetadata,
  Message,
  WireFrame,
} from '@livething/core';

export type { ReadableStore } from '~/internal/store.ts';
export type { Socket, SocketConnection, ContractError } from '~/socket/api.ts';
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
  ChannelsOf,
  StreamsOf,
  ClientRequestsOf,
  ServerRequestsOf,
  ErrorsOf,
  BinaryOf,
  UploadsOf,
  BinaryContract,
  Simplify,
  RequestMethod,
  ScopedMessaging,
  ScopedApi,
  StreamHandle,
  StreamHandlers,
  NudgesOf,
  GapInfo,
  PersistentStreamKeys,
} from '~/types.ts';

export type {
  TypeFn,
  EmptyTypeFn,
  Apply,
  Primitive,
  PrimitiveIdentity,
  ApplyPrimitives,
  ValidatePrimitives,
  SocketWithPrimitives,
} from '~/primitives/types.ts';
