import { persistence } from '~/persistence/persistence.ts';
import { describe, expect, it } from 'vitest';

describe('persistence()', () => {
  it('declares storage as a requirement', () => {
    expect(persistence().__requires.storage).toBe(true);
  });

  it('flips engine persistence on during setup', () => {
    let enabled = false;
    persistence().__setup?.({
      setPersistenceEnabled(value: boolean) {
        enabled = value;
      },
      onBoot() {},
      requireStorage: () => ({
        sql: {
          exec: () => ({ toArray: () => [], one: () => null, raw: () => [] }),
          transaction: () => ({}),
        },
      }),
    } as never);
    expect(enabled).toBe(true);
  });

  it('registers a boot hook that creates both durable tables and indexes', () => {
    const bootHooks: Array<() => void> = [];
    const execCalls: string[] = [];

    persistence().__setup?.({
      setPersistenceEnabled() {},
      onBoot(handler: () => void) {
        bootHooks.push(handler);
      },
      requireStorage: () => ({
        sql: {
          exec(query: string) {
            execCalls.push(query);
            return { toArray: () => [], one: () => null, raw: () => [] };
          },
          transaction: () => ({}),
        },
      }),
    } as never);

    expect(bootHooks).toHaveLength(1);
    bootHooks[0]!();
    expect(
      execCalls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS __wskit_channel_memberships')),
    ).toBe(true);
    expect(execCalls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS __wskit_tags'))).toBe(true);
    expect(
      execCalls.some((q) =>
        q.includes('CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_identity'),
      ),
    ).toBe(true);
    expect(
      execCalls.some((q) =>
        q.includes('CREATE INDEX IF NOT EXISTS __wskit_idx_channel_memberships_channel'),
      ),
    ).toBe(true);
    expect(
      execCalls.some((q) => q.includes('CREATE INDEX IF NOT EXISTS __wskit_idx_tags_identity')),
    ).toBe(true);
    expect(
      execCalls.some((q) => q.includes('CREATE INDEX IF NOT EXISTS __wskit_idx_tags_group_key')),
    ).toBe(true);
  });
});
