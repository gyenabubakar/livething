/* oxlint-disable @typescript-eslint/no-explicit-any */

import {
  Block,
  CloseCodes,
  error,
  RateLimited,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  ValidationFailed,
  WskitError,
} from '~/errors.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ErrorDef, ErrorDefWithFactory } from '~/errors.ts';

// ===========================================================================
// 1. CloseCodes — frozen, correct values
// ===========================================================================

const _normal: 1000 = CloseCodes.NORMAL;
const _goingAway: 1001 = CloseCodes.GOING_AWAY;
const _authExpired: 4001 = CloseCodes.AUTH_EXPIRED;
const _authInvalid: 4002 = CloseCodes.AUTH_INVALID;
const _duplicate: 4003 = CloseCodes.DUPLICATE;
const _idle: 4004 = CloseCodes.IDLE;
const _rateLimited: 4005 = CloseCodes.RATE_LIMITED;
const _banned: 4009 = CloseCodes.BANNED;
const _capacity: 4010 = CloseCodes.CAPACITY;
void [
  _normal,
  _goingAway,
  _authExpired,
  _authInvalid,
  _duplicate,
  _idle,
  _rateLimited,
  _banned,
  _capacity,
];

// @ts-expect-error — CloseCodes is frozen, cannot add properties
CloseCodes.NEW_CODE = 5000;

// ===========================================================================
// 2. WskitError — constructor and properties
// ===========================================================================

const wsErr = new WskitError('forbidden', { reason: 'not a member' });

const _code: 'forbidden' = wsErr.code;
const _detail: { reason: string } = wsErr.detail;
void [_code, _detail];

const _isError: boolean = wsErr instanceof Error;
void _isError;

// WskitError with void detail (code-only)
const wsErrVoid = new WskitError('not-found', undefined as void);
const _voidCode: 'not-found' = wsErrVoid.code;
void _voidCode;

// ===========================================================================
// 3. error() — code-only overload
// ===========================================================================

const NotFound = error('not-found');

const _notFoundCode: 'not-found' = NotFound.code;
void _notFoundCode;

const _notFoundDef: ErrorDef<'not-found', void> = NotFound;
void _notFoundDef;

// Code-only errors are callable — factory returns WskitError with void detail
const _notFoundErr: WskitError<'not-found', void> = NotFound();
void _notFoundErr;

// .matches() exists
const _matchesFn: (err: unknown) => err is WskitError<'not-found', void> = NotFound.matches;
void _matchesFn;

// ===========================================================================
// 4. error() — parse function overload
// ===========================================================================

const Forbidden = error('forbidden', (p: unknown) => {
  const obj = p as Record<string, unknown>;
  if (typeof obj.reason !== 'string') throw new Error('reason required');
  return { reason: obj.reason };
});

// Callable — creates WskitError
const forbiddenErr = Forbidden({ reason: 'not a member' });
const _fCode: 'forbidden' = forbiddenErr.code;
const _fDetail: { reason: string } = forbiddenErr.detail;
void [_fCode, _fDetail];

// @ts-expect-error — wrong detail shape
Forbidden({ wrong: true });

// @ts-expect-error — missing detail
Forbidden();

// .matches() narrows to WskitError<'forbidden', { reason: string }>
declare const unknownErr: unknown;
if (Forbidden.matches(unknownErr)) {
  const _mc: 'forbidden' = unknownErr.code;
  const _md: { reason: string } = unknownErr.detail;
  void [_mc, _md];
}

// ===========================================================================
// 5. error() — StandardSchema overload
// ===========================================================================

declare const mockSchema: StandardSchemaV1<unknown, { limit: number }>;
const QuotaExceeded = error('quota-exceeded', mockSchema);

// Callable
const quotaErr = QuotaExceeded({ limit: 100 } as { limit: number });
const _qCode: 'quota-exceeded' = quotaErr.code;
const _qDetail: { limit: number } = quotaErr.detail;
void [_qCode, _qDetail];

// .matches() narrows correctly
declare const anyErr: unknown;
if (QuotaExceeded.matches(anyErr)) {
  const _qmc: 'quota-exceeded' = anyErr.code;
  const _qmd: { limit: number } = anyErr.detail;
  void [_qmc, _qmd];
}

// ===========================================================================
// 6. .matches() — negative cases
// ===========================================================================

// .matches() returns false for non-WskitError — plain Error is not WskitError
declare const plainError: Error;
const _plainMatch: boolean = Forbidden.matches(plainError);
void _plainMatch;

// .matches() on code-only error narrows detail to void
if (NotFound.matches(unknownErr)) {
  const _nc: 'not-found' = unknownErr.code;
  const _nd: void = unknownErr.detail;
  void [_nc, _nd];
}

// ===========================================================================
// 7. ErrorDef — type structure
// ===========================================================================

// Code-only error() returns a callable factory with void detail
const _codeOnlyDef: ErrorDefWithFactory<'gone', void> = error('gone');
_codeOnlyDef();

// ErrorDef (the base interface) is still non-callable by type
const _baseOnlyDef: ErrorDef<'gone', void> = error('gone');
void _baseOnlyDef;

// Factory ErrorDef IS callable
const _factoryDef = error('bad-input', (p: unknown) => p as { field: string });
_factoryDef({ field: 'name' });

// ===========================================================================
// 8. error codes — lowercase-kebab convention enforced by types
// ===========================================================================

// These compile — lowercase kebab
error('not-found');
error('rate-limited');
error('internal-error');

// These also compile — TS doesn't enforce kebab at the type level,
// but the convention is documented. Runtime enforcement is the engine's job.
error('NotFound');
error('SCREAMING');

// ===========================================================================
// 9. Block — frozen singleton
// ===========================================================================

const _blockWskit: 'block' = Block.__wskit;
void _blockWskit;

// @ts-expect-error — Block is frozen, cannot add properties
Block.extra = true;

// ===========================================================================
// 10. ValidationFailed — built-in error def with factory
// ===========================================================================

const _vfCode: 'validation-failed' = ValidationFailed.code;
void _vfCode;

const vfErr = ValidationFailed({
  event: 'send-message',
  issues: [{ message: 'text is required', path: ['text'] }],
});
const _vfErrCode: 'validation-failed' = vfErr.code;
const _vfDetail: {
  event: string;
  issues: Array<{ message: string; path?: Array<string | number> }>;
} = vfErr.detail;
void [_vfErrCode, _vfDetail];

// .matches() narrows correctly
declare const maybeVf: unknown;
if (ValidationFailed.matches(maybeVf)) {
  const _mc: 'validation-failed' = maybeVf.code;
  const _md: { event: string; issues: Array<{ message: string; path?: Array<string | number> }> } =
    maybeVf.detail;
  void [_mc, _md];
}

// ===========================================================================
// 11. StreamAborted — built-in with parsed detail
// ===========================================================================

const _saCode: 'stream-aborted' = StreamAborted.code;
void _saCode;

type StreamAbortedReason =
  | 'cancelled'
  | 'buffer-full'
  | 'expired'
  | 'not-found'
  | 'hibernation-wake'
  | 'unsubscribed'
  | 'cursor-invalid'
  | 'aborted';

const saErr = StreamAborted({ reason: 'hibernation-wake' });
const _saErrCode: 'stream-aborted' = saErr.code;
const _saDetail: { reason: StreamAbortedReason } = saErr.detail;
void [_saErrCode, _saDetail];

// @ts-expect-error — missing reason
StreamAborted({});

// @ts-expect-error — unknown reason value (only literal union allowed)
StreamAborted({ reason: 'unknown' });

declare const maybeSa: unknown;
if (StreamAborted.matches(maybeSa)) {
  const _sac: 'stream-aborted' = maybeSa.code;
  const _sad: { reason: StreamAbortedReason } = maybeSa.detail;
  void [_sac, _sad];
}

// ===========================================================================
// 12. StreamAlreadyActive — built-in with parsed detail
// ===========================================================================

const _saaCode: 'stream-already-active' = StreamAlreadyActive.code;
void _saaCode;

const saaErr = StreamAlreadyActive({ event: 'start-tokens', _streamId: 'stream_1' });
const _saaErrCode: 'stream-already-active' = saaErr.code;
const _saaDetail: { event: string; _streamId: string } = saaErr.detail;
void [_saaErrCode, _saaDetail];

// @ts-expect-error — missing _streamId
StreamAlreadyActive({ event: 'start-tokens' });

// @ts-expect-error — missing event
StreamAlreadyActive({ _streamId: 'stream_1' });

declare const maybeSaa: unknown;
if (StreamAlreadyActive.matches(maybeSaa)) {
  const _saamc: 'stream-already-active' = maybeSaa.code;
  const _saamd: { event: string; _streamId: string } = maybeSaa.detail;
  void [_saamc, _saamd];
}

// ===========================================================================
// 13. StreamIdCollision — code-only built-in
// ===========================================================================

const _sicCode: 'stream-id-collision' = StreamIdCollision.code;
void _sicCode;

const _sicErr: WskitError<'stream-id-collision', void> = StreamIdCollision();
void _sicErr;

declare const maybeSic: unknown;
if (StreamIdCollision.matches(maybeSic)) {
  const _sicc: 'stream-id-collision' = maybeSic.code;
  const _sicd: void = maybeSic.detail;
  void [_sicc, _sicd];
}

// ===========================================================================
// 14. RateLimited — built-in with parsed detail
// ===========================================================================

const _rlCode: 'rate-limited' = RateLimited.code;
void _rlCode;

const rlErr = RateLimited({ retryAfter: 5 });
const _rlErrCode: 'rate-limited' = rlErr.code;
const _rlDetail: { retryAfter: number } = rlErr.detail;
void [_rlErrCode, _rlDetail];

// @ts-expect-error — missing retryAfter
RateLimited({});

// @ts-expect-error — wrong shape
RateLimited({ retryAfter: 'soon' });

declare const maybeRl: unknown;
if (RateLimited.matches(maybeRl)) {
  const _rlmc: 'rate-limited' = maybeRl.code;
  const _rlmd: { retryAfter: number } = maybeRl.detail;
  void [_rlmc, _rlmd];
}
