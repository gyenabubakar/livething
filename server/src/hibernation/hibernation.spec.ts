import { hibernation } from '~/hibernation/hibernation.ts';
import { describe, expect, it } from 'vitest';

describe('hibernation()', () => {
  it('defaults to enabled', () => {
    const primitive = hibernation();
    expect(primitive.enabled).toBe(true);
    expect(primitive.__requires.hibernation).toBe(true);
  });

  it('accepts false explicitly', () => {
    const primitive = hibernation(false);
    expect(primitive.enabled).toBe(false);
  });

  it('does not declare any requirements when disabled', () => {
    const primitive = hibernation(false);
    expect(primitive.__requires.hibernation).toBeUndefined();
  });

  it('registers the hibernation setting during setup', () => {
    const primitive = hibernation(false);
    let enabled = true;

    primitive.__setup?.({
      setHibernationEnabled(value: boolean) {
        enabled = value;
      },
      onBoot() {},
      onBootSchema() {},
    } as never);

    expect(enabled).toBe(false);
  });

  it('registers a schema hook that ensures the connection schema when enabled', () => {
    const primitive = hibernation(true);
    const schemaHooks: Array<() => void> = [];
    const execCalls: string[] = [];

    primitive.__setup?.({
      setHibernationEnabled() {},
      onBoot() {},
      onBootSchema(handler: () => void) {
        schemaHooks.push(handler);
      },
      storage: {
        sql: {
          exec(query: string) {
            execCalls.push(query);
            return { toArray: () => [], one: () => null, raw: () => [] };
          },
          transaction: () => ({}),
        },
      },
    } as never);

    expect(schemaHooks).toHaveLength(1);
    schemaHooks[0]!();
    expect(
      execCalls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS __livething_connections')),
    ).toBe(true);
    expect(
      execCalls.some((q) =>
        q.includes('CREATE INDEX IF NOT EXISTS __livething_idx_connections_user_id'),
      ),
    ).toBe(true);
  });

  it('does not register a schema hook when disabled', () => {
    const primitive = hibernation(false);
    const schemaHooks: Array<() => void> = [];

    primitive.__setup?.({
      setHibernationEnabled() {},
      onBoot() {},
      onBootSchema(handler: () => void) {
        schemaHooks.push(handler);
      },
    } as never);

    expect(schemaHooks).toHaveLength(0);
  });
});
