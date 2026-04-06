import { sequence } from '~/primitives/sequence.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type { SequencePrimitive } from '~/primitives/sequence.ts';

const sequencePrimitive = sequence();
const _sequenceType: SequencePrimitive = sequencePrimitive;
void _sequenceType;

const _tag: 'sequence' = sequencePrimitive.__wskit;
const _kind: PrimitiveKind = sequencePrimitive.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = sequence;
const _key: symbol = sequence.__key;
void [_ref, _key];
