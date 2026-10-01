import { sequence } from '~/sequence/sequence.ts';
import { describe, expect, it } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { SQLProvider } from '~/context.ts';

class FakeSqlResult<TRow = unknown> {
  constructor(private readonly rows: TRow[]) {}

  toArray(): TRow[] {
    return [...this.rows];
  }

  one(): TRow | null {
    return this.rows[0] ?? null;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row as Record<string, unknown>));
  }
}

class FakeSqlProvider implements SQLProvider {
  readonly sequence = new Map<string, { scope: string; nextSeq: number }>();
  readonly limits = {
    maxBoundParams: 32_766,
    maxStatementBytes: 1_000_000_000,
    maxValueBytes: 1_000_000_000,
  };

  exec<TRow = unknown>(query: string, ...params: unknown[]): FakeSqlResult<TRow> {
    const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS __livething_sequence')) {
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('SELECT nextSeq FROM __livething_sequence WHERE scope = ?')) {
      const scope = String(params[0]);
      const row = this.sequence.get(scope);
      return new FakeSqlResult<TRow>((row ? [row] : []) as TRow[]);
    }

    if (
      normalizedQuery.startsWith('INSERT INTO __livething_sequence (scope, nextSeq) VALUES (?, ?)')
    ) {
      const scope = String(params[0]);
      this.sequence.set(scope, {
        scope,
        nextSeq: Number(params[1]),
      });
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('UPDATE __livething_sequence SET nextSeq = ? WHERE scope = ?')) {
      const scope = String(params[1]);
      this.sequence.set(scope, {
        scope,
        nextSeq: Number(params[0]),
      });
      return new FakeSqlResult<TRow>([]);
    }

    return new FakeSqlResult<TRow>([]);
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }
}

function installSequence(
  options?: { persist?: boolean },
  sql = new FakeSqlProvider(),
): {
  stampHandlers: Array<NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>>;
  bootHandlers: Array<NonNullable<Parameters<EngineAccess['onBootSchema']>[0]>>;
  hook: NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>;
  sql: FakeSqlProvider;
} {
  const stampHandlers: Array<NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>> = [];
  const bootHandlers: Array<NonNullable<Parameters<EngineAccess['onBootSchema']>[0]>> = [];
  const installs = new Set<symbol>();

  const engine = {
    installOnce(key, install) {
      if (installs.has(key)) return;

      installs.add(key);
      install();
    },
    onBoot() {},
    onBootSchema(handler) {
      bootHandlers.push(handler);
    },
    onLiveThingStamp(handler) {
      stampHandlers.push(handler);
    },
    setSequencePersistent() {},
    storage: {
      sql,
      kv: {
        async get() {
          return undefined;
        },
        async set() {},
        async delete() {},
        async list() {
          return [];
        },
      },
    },
  } as Pick<
    EngineAccess,
    | 'installOnce'
    | 'onBoot'
    | 'onBootSchema'
    | 'onLiveThingStamp'
    | 'storage'
    | 'setSequencePersistent'
  > as EngineAccess;

  sequence(options).__setup?.(engine);

  const hook = stampHandlers[0];

  expect(hook).toBeDefined();

  return {
    stampHandlers,
    bootHandlers,
    hook: hook!,
    sql,
  };
}

describe('sequence', () => {
  it('produces correct tag and kind', () => {
    const p = sequence();
    expect(p.__livething).toBe('sequence');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = sequence();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(sequence.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = sequence();
    expect(p.__requires).toEqual({});
  });

  it('durable sequence tracking has empty requires', () => {
    const p = sequence({ persist: true });
    expect(p.persist).toBe(true);
    expect(p.__requires).toEqual({});
  });

  it('registers its stamp hook only once', () => {
    const stampHandlers: Array<NonNullable<Parameters<EngineAccess['onLiveThingStamp']>[0]>> = [];
    const installs = new Set<symbol>();
    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;

        installs.add(key);
        install();
      },
      onLiveThingStamp(handler) {
        stampHandlers.push(handler);
      },
      setSequencePersistent() {},
    } as Pick<
      EngineAccess,
      'installOnce' | 'onLiveThingStamp' | 'setSequencePersistent'
    > as EngineAccess;

    sequence().__setup?.(engine);
    sequence().__setup?.(engine);

    expect(stampHandlers).toHaveLength(1);
  });

  it('stamps an increasing seq into __livething for outgoing messages', () => {
    const { hook } = installSequence();
    const first = hook('message');
    const second = hook('alert');

    expect(first).toEqual({ deliverySeq: 1 });
    expect(second).toEqual({ deliverySeq: 2 });
  });

  it('still stamps plugin-owned outgoing events with a double underscore prefix', () => {
    const { hook } = installSequence();
    const pluginMessage = hook('__acme:analytics:flushed');

    expect(pluginMessage).toEqual({ deliverySeq: 1 });
  });

  it('creates its SQLite table during boot when persistence is enabled', async () => {
    const { bootHandlers, sql } = installSequence({ persist: true });

    expect(bootHandlers).toHaveLength(1);

    await bootHandlers[0]?.();

    expect(sql.sequence.size).toBe(0);
  });

  it('continues the counter from SQLite when persistence is enabled', async () => {
    const sharedSql = new FakeSqlProvider();
    const first = installSequence({ persist: true }, sharedSql);
    const second = installSequence({ persist: true }, sharedSql);

    await first.bootHandlers[0]?.();
    await second.bootHandlers[0]?.();

    const firstMessage = first.hook('message');
    const secondMessage = second.hook('message');

    // The persistent allocator reserves seq numbers in batches (default 100)
    // so the SQL write rate stays at ~1-per-batch instead of 1-per-send. The
    // first allocator reserves [1, 101); the second sees nextSeq=101 in
    // storage and reserves [101, 201). Wire gaps from unused reservations are
    // expected and harmless — clients treat sequence gaps as "ask the server
    // what's missing", not as lost messages.
    expect(firstMessage).toEqual({ deliverySeq: 1 });
    expect(secondMessage).toEqual({ deliverySeq: 101 });
  });
});
