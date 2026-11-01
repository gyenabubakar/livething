import { dedup } from '~/dedup/dedup.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';

const dedupPrimitive = dedup();
const _dedupType: DedupPrimitive = dedupPrimitive;
void _dedupType;

const _tag: 'dedup' = dedupPrimitive.__livething;
void _tag;
