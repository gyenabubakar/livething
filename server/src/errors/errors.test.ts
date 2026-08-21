/* oxlint-disable @typescript-eslint/no-explicit-any */

import { WSKitError } from '@wskit/core';
import {
  Block,
  CloseCodes,
  CrossInstanceRef,
  Defer,
  DeferExhausted,
  Disconnect,
  error,
  RejectUpgrade,
  ValidationFailed,
} from './errors.ts';
import type { ErrorDef, ErrorDefWithFactory } from './errors.ts';

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

const dc = Disconnect(4009, 'banned');
const _dcWSKit: 'disconnect' = dc.__wskit;
const _dcCode: number = dc.code;
const _dcReason: string = dc.reason;
void [_dcWSKit, _dcCode, _dcReason];

const ru = RejectUpgrade(4002, 'Invalid token');
const _ruWSKit: 'reject-upgrade' = ru.__wskit;
const _ruCode: number = ru.code;
const _ruReason: string = ru.reason;
void [_ruWSKit, _ruCode, _ruReason];

const df = Defer(1000);
const _dfWSKit: 'defer' = df.__wskit;
const _dfDelay: number = df.delay;
void [_dfWSKit, _dfDelay];

const _deCode: 'defer-exhausted' = DeferExhausted.code;
void _deCode;

declare const unknownErr: unknown;

const _cirCode: 'cross-instance-ref' = CrossInstanceRef.code;
void _cirCode;

const cirErr = CrossInstanceRef({
  operation: 'ctx.channel.request({ to })',
  targetInstance: 'other',
  engineInstance: 'local',
});
const _cirDetail: {
  operation: string;
  targetInstance?: string;
  engineInstance?: string;
} = cirErr.detail;
void [_cirDetail, cirErr];

if (CrossInstanceRef.matches(unknownErr)) {
  const _cirMatchCode: 'cross-instance-ref' = unknownErr.code;
  const _cirMatchDetail: {
    operation: string;
    targetInstance?: string;
    engineInstance?: string;
  } = unknownErr.detail;
  void [_cirMatchCode, _cirMatchDetail];
}

const deErr = DeferExhausted({ event: 'send-message', payload: { text: 'hi' }, retries: 3 });
const _deErrCode: 'defer-exhausted' = deErr.code;
const _deDetail: { event: string; payload: unknown; retries: number } = deErr.detail;
void [_deErrCode, _deDetail];

if (DeferExhausted.matches(unknownErr)) {
  const _mc: 'defer-exhausted' = unknownErr.code;
  const _md: { event: string; payload: unknown; retries: number } = unknownErr.detail;
  void [_mc, _md];
}

const _isWSKitErr: boolean = deErr instanceof WSKitError;
void _isWSKitErr;
