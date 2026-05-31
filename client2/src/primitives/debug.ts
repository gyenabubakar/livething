import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

/** Enable or disable console debug logging of connection events and message flow. */
export function debug(enabled: boolean): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'debug',
    applyConfig(config) {
      config.debug = enabled;
    },
  };
}
