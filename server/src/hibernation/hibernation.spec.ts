import { hibernation } from '~/hibernation/hibernation.ts';
import { describe, expect, it } from 'vitest';

describe('hibernation()', () => {
  it('defaults to enabled', () => {
    const primitive = hibernation();
    expect(primitive.enabled).toBe(true);
    expect(primitive.__requires.hibernation).toBe(true);
  });

  it('declares the storage requirement when enabled', () => {
    // Per-connection state moved to engine SQL — without it, a hibernating
    // engine has no way to rebuild a connection on wake. The build-time
    // check at engine.initialize() reads this manifest entry.
    const primitive = hibernation();
    expect(primitive.__requires.storage).toBe(true);
  });

  it('accepts false explicitly', () => {
    const primitive = hibernation(false);
    expect(primitive.enabled).toBe(false);
  });

  it('does not declare any requirements when disabled', () => {
    const primitive = hibernation(false);
    expect(primitive.__requires.hibernation).toBeUndefined();
    expect(primitive.__requires.storage).toBeUndefined();
  });

  it('registers the hibernation setting during setup', () => {
    const primitive = hibernation(false);
    let enabled = true;

    primitive.__setup?.({
      setHibernationEnabled(value: boolean) {
        enabled = value;
      },
      onBoot() {},
    } as never);

    expect(enabled).toBe(false);
  });

  it('registers a boot hook that ensures the connection schema when enabled', () => {
    const primitive = hibernation(true);
    const bootHooks: Array<() => void> = [];
    const execCalls: string[] = [];

    primitive.__setup?.({
      setHibernationEnabled() {},
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
    expect(execCalls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS _wskit_connections'))).toBe(
      true,
    );
    expect(
      execCalls.some((q) =>
        q.includes('CREATE INDEX IF NOT EXISTS idx_wskit_connections_identity'),
      ),
    ).toBe(true);
  });

  it('does not register a boot hook when disabled', () => {
    const primitive = hibernation(false);
    const bootHooks: Array<() => void> = [];

    primitive.__setup?.({
      setHibernationEnabled() {},
      onBoot(handler: () => void) {
        bootHooks.push(handler);
      },
    } as never);

    expect(bootHooks).toHaveLength(0);
  });
});
