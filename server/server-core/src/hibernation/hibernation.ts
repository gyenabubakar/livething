import type { Primitive } from '~/primitive.ts';

export interface HibernationPrimitive extends Primitive<'hibernation'> {
  readonly enabled: boolean;
}

const HIBERNATION_KEY = Symbol('hibernation');

export function hibernation(enabled = true): HibernationPrimitive {
  return {
    __wskit: 'hibernation',
    __kind: 'infrastructure',
    __identity: [HIBERNATION_KEY],
    __dependencies: [],
    __requires: { hibernation: true },
    enabled,
    __setup(engine) {
      engine.setHibernationEnabled(enabled);
    },
  };
}

hibernation.__key = HIBERNATION_KEY;
