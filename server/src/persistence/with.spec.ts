import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { withPersistence } from '~/persistence/with.ts';
import { describe, expect, it } from 'vitest';

const Beat = event('beat', (p: unknown) => p as { value: number });

describe('withPersistence wrapper', () => {
  it('adds a persistence primitive when .enablePersistence() is called', () => {
    const def = withPersistence(server('chat')).enablePersistence().outgoing(Beat).build();

    expect(def.primitives.some((p) => p.__wskit === 'persistence')).toBe(true);
  });

  it('does not add the primitive when .enablePersistence() is omitted', () => {
    const def = withPersistence(server('chat')).outgoing(Beat).build();

    expect(def.primitives.some((p) => p.__wskit === 'persistence')).toBe(false);
  });

  it('.enablePersistence() is a type error without the wrapper', () => {
    // The call is wrapped in a never-invoked function so the runtime
    // doesn't trip on the missing method — the @ts-expect-error proves
    // the type guarantee, which is what we care about.
    () => {
      // @ts-expect-error — .enablePersistence() requires withPersistence()
      server('chat').enablePersistence();
    };
  });

  it('the persistence primitive requires storage', () => {
    const def = withPersistence(server('chat')).enablePersistence().build();
    const prim = def.primitives.find((p) => p.__wskit === 'persistence');
    expect(prim?.__requires).toEqual({ storage: true });
  });
});
