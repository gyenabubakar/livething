/* oxlint-disable @typescript-eslint/no-explicit-any */

import { error } from '~/errors.ts';
import { errors } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/errors.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const Forbidden = error('forbidden', (value: unknown) => value as { reason: string });
const ChannelNotFound = error(
  'channel-not-found',
  (value: unknown) => value as { channel: string },
);
const QuotaExceeded = error('quota-exceeded', (value: unknown) => value as { limit: number });

// ===========================================================================
// 1. errors() carries the exact tuple of error defs
// ===========================================================================

const declared = errors(Forbidden, ChannelNotFound, QuotaExceeded);

const _primitiveType: ErrorsPrimitive<
  readonly [typeof Forbidden, typeof ChannelNotFound, typeof QuotaExceeded]
> = declared;
void _primitiveType;

// ===========================================================================
// 2. Primitive base fields present
// ===========================================================================

const _tag: 'errors' = declared.__wskit;
const _kind: PrimitiveKind = declared.__kind;
void [_tag, _kind];

// ===========================================================================
// 3. defs are stored in order
// ===========================================================================

const _defs: readonly [typeof Forbidden, typeof ChannelNotFound, typeof QuotaExceeded] =
  declared.defs;
const _firstCode: 'forbidden' = declared.defs[0]!.code;
const _secondCode: 'channel-not-found' = declared.defs[1]!.code;
const _thirdCode: 'quota-exceeded' = declared.defs[2]!.code;
void [_defs, _firstCode, _secondCode, _thirdCode];

// ===========================================================================
// 4. errors is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = errors;
const _key: symbol = errors.__key;
void [_ref, _key];
