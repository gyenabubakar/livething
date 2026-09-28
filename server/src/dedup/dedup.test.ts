import { dedup } from '~/dedup/dedup.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const dedupPrimitive = dedup();
const _dedupType: DedupPrimitive = dedupPrimitive;
void _dedupType;

const _tag: 'dedup' = dedupPrimitive.__livething;
const _kind: PrimitiveKind = dedupPrimitive.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = dedup;
const _key: symbol = dedup.__key;
void [_ref, _key];
