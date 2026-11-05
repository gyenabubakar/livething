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
  Disconnected,
  Dropped,
  DurableStreamRequiresUser,
  InternalError,
  Timeout,
  NotAMember,
  NudgeOverflow,
  RateLimited,
  ConnectionBusy,
  RejoinRejected,
  RequestInvalidResponse,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamCorrupted,
  StreamAlreadyActive,
  StreamIdCollision,
  UnsupportedProtocol,
  WrongFrameKind,
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
export { utf8ByteLength } from './utf8.ts';
export {
  BINARY_ENVELOPE_LIMIT,
  BINARY_HEADER_LENGTH,
  asUint8Array,
  encodeBinaryFrame,
  splitBinaryFrame,
} from './binary.ts';
export type { BinaryInput, SplitBinaryFrame } from './binary.ts';
export type {
  LiveThingChannelMetadata,
  LiveThingDeliveryMetadata,
  LiveThingExchangeMetadata,
  LiveThingMetadata,
  LiveThingStreamMetadata,
  Message,
  WireFrame,
} from './wire.ts';
