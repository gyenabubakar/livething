import { describe, expectTypeOf, it } from 'vitest';
import type { CtxLocalsClient } from './handler.ts';

describe('CtxLocalsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxLocalsClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxLocalsClient['outgoing']>().not.toBeAny();
  });
});

describe('CtxLocalsClient — top-level events', () => {
  it('outgoing has echo', () => {
    expectTypeOf<CtxLocalsClient['outgoing']['echo']>().toEqualTypeOf<{ text: string }>();
  });

  it('incoming has echoed', () => {
    expectTypeOf<CtxLocalsClient['incoming']['echoed']>().toEqualTypeOf<{ text: string }>();
  });
});
