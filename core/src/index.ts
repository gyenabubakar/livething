export {
  error,
  namespaceError,
  WskitError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  InternalError,
  InvalidScopeMarkers,
  NamespaceNotFound,
  RateLimited,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
} from './errors.ts';
export type { ErrorDef, ErrorDefWithFactory, StreamAbortedReason } from './errors.ts';
export {
  WskitConfigError,
  isWskitConfigError,
  rethrowIfConfigError,
  assertSyncResult,
} from './sync-guard.ts';
export { isValidWSKitIdentifier, assertValidWSKitIdentifier } from './identifier.ts';
