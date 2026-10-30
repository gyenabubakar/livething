import { hibernation } from '~/hibernation/hibernation.ts';
import { describe, expect, it } from 'vitest';

describe('hibernation()', () => {
  it('requires adapter hibernation support', () => {
    expect(hibernation().__requires.hibernation).toBe(true);
  });

  it('turns hibernation on during setup', () => {
    let enabled = false;

    hibernation().__setup?.({
      enableHibernation() {
        enabled = true;
      },
      onBootSchema() {},
    } as never);

    expect(enabled).toBe(true);
  });

  it('registers a schema hook that ensures the connection schema', () => {
    const schemaHooks: Array<() => void> = [];
    const execCalls: string[] = [];

    hibernation().__setup?.({
      enableHibernation() {},
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
});
