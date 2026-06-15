import { ack } from '~/ack/ack.ts';
import type { AckPrimitive } from '~/ack/ack.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const ackPrimitive = ack();
const _ackType: AckPrimitive = ackPrimitive;
void _ackType;

const _tag: 'ack' = ackPrimitive.__wskit;
const _kind: PrimitiveKind = ackPrimitive.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = ack;
const _key: symbol = ack.__key;
void [_ref, _key];
