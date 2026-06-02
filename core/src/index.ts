export {
  error,
  namespaceError,
  WSKitError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  InternalError,
  InvalidScopeMarkers,
  NamespaceNotFound,
  NudgeOverflow,
  RateLimited,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
} from './errors.ts';
export type { ErrorDef, ErrorDefWithFactory, StreamAbortedReason } from './errors.ts';
export {
  WSKitConfigError,
  isWSKitConfigError,
  rethrowIfConfigError,
  assertSyncResult,
} from './sync-guard.ts';
export { isValidWSKitIdentifier, assertValidWSKitIdentifier } from './identifier.ts';
