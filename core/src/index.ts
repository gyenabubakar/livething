export {
  error,
  namespaceError,
  WSKitError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  DurableStreamRequiresUser,
  InternalError,
  NudgeOverflow,
  RateLimited,
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
  WSKitConfigError,
  isWSKitConfigError,
  rethrowIfConfigError,
  assertSyncResult,
} from './sync-guard.ts';
export {
  isValidWSKitIdentifier,
  assertValidWSKitIdentifier,
  WIRE_LIMITS,
  exceedsWireLimit,
} from './identifier.ts';
