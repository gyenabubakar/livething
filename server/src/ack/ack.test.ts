import { ack } from '~/ack/ack.ts';
import type { AckPrimitive } from '~/ack/ack.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

// ===========================================================================
// 1. ack() returns the right primitive type
// ===========================================================================

const ackPrimitive = ack();
const _ackType: AckPrimitive = ackPrimitive;
void _ackType;

// ===========================================================================
// 2. Primitive base fields present
// ===========================================================================

const _tag: 'ack' = ackPrimitive.__wskit;
const _kind: PrimitiveKind = ackPrimitive.__kind;
void [_tag, _kind];

// ===========================================================================
// 3. ack is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = ack;
const _key: symbol = ack.__key;
void [_ref, _key];
