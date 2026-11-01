import { sequence } from '~/sequence/sequence.ts';
import type { SequenceOptions, SequencePrimitive } from '~/sequence/sequence.ts';

const sequencePrimitive = sequence();
const _sequenceType: SequencePrimitive = sequencePrimitive;
void _sequenceType;

const _tag: 'sequence' = sequencePrimitive.__livething;
void _tag;

const options: SequenceOptions = { persist: true };
const durableSequence = sequence(options);
const _persist: boolean = durableSequence.persist;
void _persist;
