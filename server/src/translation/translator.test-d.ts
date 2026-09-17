/* oxlint-disable no-unused-vars */
import { server } from '~/_define/server.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import { translator } from './translator.ts';

const validated = translator(() => ({
  input: v.object({ event: v.string(), payload: v.number() }),
  inbound(frame) {
    expectTypeOf(frame).toEqualTypeOf<{ event: string; payload: number }>();
    return JSON.stringify(frame);
  },
}));
void validated;

translator(() => ({
  inbound(raw) {
    expectTypeOf(raw).toEqualTypeOf<string>();
    return raw;
  },
}));

translator(() => ({
  inbound: (raw) => raw,
  hibernation: {
    serialize() {
      return { sequence: 0 };
    },
    restore(state) {
      expectTypeOf(state).toEqualTypeOf<{ sequence: number } | undefined>();
      void state?.sequence;
    },
  },
}));

translator(() => ({
  inbound: (raw) => raw,
  // @ts-expect-error hibernation state requires restore()
  hibernation: {
    serialize: () => 0,
  },
}));

translator(() => ({
  inbound: (raw) => raw,
  // @ts-expect-error hibernation state requires serialize()
  hibernation: {
    restore: (_state: number | undefined) => {},
  },
}));

const serverOnly = translator(() => ({ inbound: (raw) => raw }));
server({ translate: serverOnly });

// @ts-expect-error translation belongs to the app server, not a plugin scope
server({ scope: 'plugin', translate: serverOnly });
