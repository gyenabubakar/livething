import { createTestSql } from '~/_test/sql.ts';
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
      setPersistenceService() {},
      onBoot() {},
      onBootSchema() {},
      requireStorage: () => ({
        sql: {
          exec: () => ({ toArray: () => [], one: () => null, raw: () => [] }),
          transaction: () => ({}),
        },
      }),
    } as never);
    expect(enabled).toBe(true);
  });

  it('registers a schema hook that creates both durable tables and indexes', () => {
    const sql = createTestSql();
    const schemaHooks: Array<() => void> = [];

    persistence().__setup?.({
      setPersistenceEnabled() {},
      setPersistenceService() {},
      onBoot() {},
      onBootSchema(handler: () => void) {
        schemaHooks.push(handler);
      },
      requireStorage: () => ({ sql }),
    } as never);

    expect(schemaHooks).toHaveLength(1);
    schemaHooks[0]!();

    const created = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .toArray()
      .map((row) => row.name);

    expect(created).toContain('__wskit_channel_memberships');
    expect(created).toContain('__wskit_tags');
    expect(created).toContain('__wskit_idx_channel_memberships_user');
    expect(created).toContain('__wskit_idx_channel_memberships_channel');
    expect(created).toContain('__wskit_idx_tags_user');
    expect(created).toContain('__wskit_idx_tags_group_key');
  });
});
