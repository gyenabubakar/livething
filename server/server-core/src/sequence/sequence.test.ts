import { sequence } from '~/sequence/sequence.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type { SequenceOptions, SequencePrimitive } from '~/sequence/sequence.ts';

const sequencePrimitive = sequence();
const _sequenceType: SequencePrimitive = sequencePrimitive;
void _sequenceType;

const _tag: 'sequence' = sequencePrimitive.__wskit;
const _kind: PrimitiveKind = sequencePrimitive.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = sequence;
const _key: symbol = sequence.__key;
void [_ref, _key];

const options: SequenceOptions = { persist: true };
const durableSequence = sequence(options);
const _persist: boolean = durableSequence.persist;
void _persist;
