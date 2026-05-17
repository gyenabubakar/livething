export {
  error,
  WskitError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  InternalError,
  InvalidScopeMarkers,
  NamespaceNotFound,
  StreamAborted,
  StreamAlreadyActive,
} from './errors.ts';
export type { ErrorDef, ErrorDefWithFactory } from './errors.ts';
export {
  WskitConfigError,
  isWskitConfigError,
  rethrowIfConfigError,
  assertSyncResult,
} from './sync-guard.ts';
