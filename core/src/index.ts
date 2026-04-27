export {
  error,
  WskitError,
  CloseCodes,
  Block,
  ValidationFailed,
  ChannelNotFound,
  ChannelNotSubscribed,
  InternalError,
} from './errors.ts';
export type { ErrorDef, ErrorDefWithFactory } from './errors.ts';
export { WskitConfigError, isWskitConfigError, assertSyncResult } from './sync-guard.ts';
