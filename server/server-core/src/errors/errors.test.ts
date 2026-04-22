/* oxlint-disable @typescript-eslint/no-explicit-any */

import { WskitError } from '@wskit/core';
import {
  Block,
  CloseCodes,
  Defer,
  DeferExhausted,
  Disconnect,
  error,
  RejectUpgrade,
  ValidationFailed,
} from './errors.ts';
import type { ErrorDef, ErrorDefWithFactory } from './errors.ts';

// ===========================================================================
// 1. Re-exports from core are accessible
// ===========================================================================

const _err: ErrorDef<'test', void> = error('test');
void _err;

const _block: { readonly __wskit: 'block' } = Block;
void _block;

const _closeCodes: typeof CloseCodes = CloseCodes;
void _closeCodes;

const _vf: ErrorDefWithFactory<
  'validation-failed',
  { event: string; issues: Array<{ message: string; path?: Array<string | number> }> }
> = ValidationFailed;
void _vf;

// ===========================================================================
// 2. Disconnect — frozen factory with code and reason
// ===========================================================================

const dc = Disconnect(4009, 'banned');
const _dcWskit: 'disconnect' = dc.__wskit;
const _dcCode: number = dc.code;
const _dcReason: string = dc.reason;
void [_dcWskit, _dcCode, _dcReason];

// ===========================================================================
// 3. RejectUpgrade — frozen factory with code and reason
// ===========================================================================

const ru = RejectUpgrade(4002, 'Invalid token');
const _ruWskit: 'reject-upgrade' = ru.__wskit;
const _ruCode: number = ru.code;
const _ruReason: string = ru.reason;
void [_ruWskit, _ruCode, _ruReason];

// ===========================================================================
// 4. Defer — frozen factory with delay
// ===========================================================================

const df = Defer(1000);
const _dfWskit: 'defer' = df.__wskit;
const _dfDelay: number = df.delay;
void [_dfWskit, _dfDelay];

// ===========================================================================
// 5. DeferExhausted — built-in error def with factory
// ===========================================================================

const _deCode: 'defer-exhausted' = DeferExhausted.code;
void _deCode;

const deErr = DeferExhausted({ event: 'send-message', payload: { text: 'hi' }, retries: 3 });
const _deErrCode: 'defer-exhausted' = deErr.code;
const _deDetail: { event: string; payload: unknown; retries: number } = deErr.detail;
void [_deErrCode, _deDetail];

// .matches() narrows correctly
declare const unknownErr: unknown;
if (DeferExhausted.matches(unknownErr)) {
  const _mc: 'defer-exhausted' = unknownErr.code;
  const _md: { event: string; payload: unknown; retries: number } = unknownErr.detail;
  void [_mc, _md];
}

// ===========================================================================
// 6. DeferExhausted is a WskitError
// ===========================================================================

const _isWskitErr: boolean = deErr instanceof WskitError;
void _isWskitErr;
