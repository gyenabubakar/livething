/* oxlint-disable @typescript-eslint/no-explicit-any */

import { Block, CloseCodes, error, Skip, ValidationFailed, WskitError } from '~/errors.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ErrorDef } from '~/errors.ts';

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

// Code-only errors are NOT callable — no factory
// @ts-expect-error — NotFound is not a function
NotFound();

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

// Code-only ErrorDef has no call signature
const _codeOnlyDef: ErrorDef<'gone', void> = error('gone');
void _codeOnlyDef;
// @ts-expect-error — not callable
_codeOnlyDef();

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
// 9. Block and Skip — frozen singletons
// ===========================================================================

const _blockWskit: 'block' = Block.__wskit;
void _blockWskit;

const _skipWskit: 'skip' = Skip.__wskit;
void _skipWskit;

// @ts-expect-error — Block is frozen, cannot add properties
Block.extra = true;

// @ts-expect-error — Skip is frozen, cannot add properties
Skip.extra = true;

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
