import { dedup } from '~/dedup/dedup.ts';
import { heartbeat } from '~/heartbeat/heartbeat.ts';
import { definePrimitive } from '~/primitive.ts';
import { sequence } from '~/sequence/sequence.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { Primitive } from '~/primitive.ts';
import type { SequencePrimitive } from '~/sequence/sequence.ts';

export type PassiveChild = HeartbeatPrimitive | SequencePrimitive | DedupPrimitive;

/**
 * The primitive instance returned by `passive()`.
 *
 * It groups infrastructure primitives that change runtime behavior but do
 * not add methods to handler ctx.
 */
export interface PassivePrimitive<
  TPrimitives extends readonly PassiveChild[] = readonly PassiveChild[],
> extends Primitive<'passive'> {
  readonly primitives: TPrimitives;
}

const PASSIVE_KEY = Symbol('passive');

const _passive = definePrimitive<
  'passive',
  [...primitives: PassiveChild[]],
  { primitives: readonly PassiveChild[] }
>({
  tag: 'passive' as const,
  key: PASSIVE_KEY,
  kind: 'infrastructure' as const,
  registrationId(...primitives: PassiveChild[]) {
    return primitives
      .map((primitive, index) => {
        const [key, registrationId] = primitive.__identity;
        return `${String(key)}:${registrationId ?? index}`;
      })
      .join('|');
  },
  create(...primitives: PassiveChild[]) {
    return {
      primitives: Object.freeze([...primitives]) as readonly PassiveChild[],
    };
  },
});

/**
 * Group runtime-only infrastructure primitives.
 *
 * Use this for infrastructure that affects transport behavior but does not
 * add anything to handler ctx, such as `heartbeat()`, `sequence()`, or
 * `dedup()`.
 */
export function passive<const TPrimitives extends readonly PassiveChild[]>(
  ...primitives: TPrimitives
): PassivePrimitive<TPrimitives> {
  return _passive(...primitives) as PassivePrimitive<TPrimitives>;
}

/** Dependency ref — use in `dependencies: [passive]` to assert it's registered. */
passive.__key = PASSIVE_KEY;

export { dedup, heartbeat, sequence };
