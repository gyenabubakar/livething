import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Turns on console logging of connection events and message flow. */
export function debug(enabled: boolean): Primitive<EmptyTypeFn> {
  return {
    _tag: 'debug',
    applyConfig(config) {
      config.debug = enabled;
    },
  };
}
