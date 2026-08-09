import { persistence } from '~/persistence/persistence.ts';
import { describe, expect, it } from 'vitest';

describe('persistence()', () => {
  it('declares no runtime capability requirements', () => {
    expect(persistence().__requires).toEqual({});
  });

  it('flips engine persistence on during setup', () => {
    let enabled = false;
    persistence().__setup?.({
      setPersistenceEnabled(value: boolean) {
        enabled = value;
      },
    } as never);
    expect(enabled).toBe(true);
  });

  it('registers no boot or schema hooks of its own — the owning capabilities do', () => {
    const bootHooks: Array<() => void> = [];
    const schemaHooks: Array<() => void> = [];

    persistence().__setup?.({
      setPersistenceEnabled() {},
      onBoot: (handler: () => void) => bootHooks.push(handler),
      onBootSchema: (handler: () => void) => schemaHooks.push(handler),
    } as never);

    expect(bootHooks).toHaveLength(0);
    expect(schemaHooks).toHaveLength(0);
  });
});
