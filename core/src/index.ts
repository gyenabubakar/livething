export {
  error,
  namespaceError,
  LiveThingError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  CrossInstanceRef,
  DeferExhausted,
  Disconnected,
  Dropped,
  DurableStreamRequiresUser,
  InternalError,
  Timeout,
  NudgeOverflow,
  RateLimited,
  ConnectionBusy,
  RejoinRejected,
  RequestInvalidResponse,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  UnsupportedProtocol,
} from './errors.ts';
export type {
  ErrorDef,
  ErrorDefWithFactory,
  StreamAbortedReason,
  UnsupportedProtocolEvent,
} from './errors.ts';
export {
  LiveThingConfigError,
  isLiveThingConfigError,
  rethrowIfConfigError,
  assertSynchronousResult,
} from './sync-guard.ts';
export {
  isValidLiveThingIdentifier,
  assertValidLiveThingIdentifier,
  WIRE_LIMITS,
  exceedsWireLimit,
} from './identifier.ts';
export { decodeMessage, encodeMessage } from './wire.ts';
export type {
  LiveThingChannelMetadata,
  LiveThingDeliveryMetadata,
  LiveThingExchangeMetadata,
  LiveThingMetadata,
  LiveThingStreamMetadata,
  Message,
  WireFrame,
} from './wire.ts';
