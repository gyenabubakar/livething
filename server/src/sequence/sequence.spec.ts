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

  exec<TRow = unknown>(query: string, ...params: unknown[]): FakeSqlResult<TRow> {
    const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_sequence')) {
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('SELECT nextSeq FROM _wskit_sequence WHERE scope = ?')) {
      const scope = String(params[0]);
      const row = this.sequence.get(scope);
      return new FakeSqlResult<TRow>((row ? [row] : []) as TRow[]);
    }

    if (
      normalizedQuery.startsWith('INSERT INTO _wskit_sequence ( scope, nextSeq ) VALUES (?, ?)')
    ) {
      const scope = String(params[0]);
      this.sequence.set(scope, {
        scope,
        nextSeq: Number(params[1]),
      });
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('UPDATE _wskit_sequence SET nextSeq = ? WHERE scope = ?')) {
      const scope = String(params[1]);
      this.sequence.set(scope, {
        scope,
        nextSeq: Number(params[0]),
      });
      return new FakeSqlResult<TRow>([]);
    }

    return new FakeSqlResult<TRow>([]);
  }

  transaction<T>(
    fn: (tx: {
      exec<TRow = unknown>(query: string, ...params: unknown[]): FakeSqlResult<TRow>;
    }) => T,
  ): T {
    return fn({ exec: this.exec.bind(this) });
  }
}

function installSequence(
  options?: { persist?: boolean },
  sql = new FakeSqlProvider(),
): {
  outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>>;
  bootHandlers: Array<NonNullable<Parameters<EngineAccess['onBoot']>[0]>>;
  hook: NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>;
  sql: FakeSqlProvider;
} {
  const outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>> = [];
  const bootHandlers: Array<NonNullable<Parameters<EngineAccess['onBoot']>[0]>> = [];
  const installs = new Set<symbol>();

  const engine = {
    installOnce(key, install) {
      if (installs.has(key)) return;

      installs.add(key);
      install();
    },
    onBoot(handler) {
      bootHandlers.push(handler);
    },
    onOutgoing(handler) {
      outgoingHandlers.push(handler);
    },
    setSequencePersistent() {},
    requireStorage() {
      return {
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
      };
    },
  } as Pick<
    EngineAccess,
    'installOnce' | 'onBoot' | 'onOutgoing' | 'requireStorage' | 'setSequencePersistent'
  > as EngineAccess;

  sequence(options).__setup?.(engine);

  const hook = outgoingHandlers[0];

  expect(hook).toBeDefined();

  return {
    outgoingHandlers,
    bootHandlers,
    hook: hook!,
    sql,
  };
}

describe('sequence', () => {
  it('produces correct tag and kind', () => {
    const p = sequence();
    expect(p.__wskit).toBe('sequence');
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

  it('requires storage when persistence is enabled', () => {
    const p = sequence({ persist: true });
    expect(p.persist).toBe(true);
    expect(p.__requires).toEqual({ storage: true });
  });

  it('registers its outgoing hook only once', () => {
    const outgoingHandlers: Array<NonNullable<Parameters<EngineAccess['onOutgoing']>[0]>> = [];
    const installs = new Set<symbol>();
    const engine = {
      installOnce(key, install) {
        if (installs.has(key)) return;

        installs.add(key);
        install();
      },
      onOutgoing(handler) {
        outgoingHandlers.push(handler);
      },
      setSequencePersistent() {},
    } as Pick<EngineAccess, 'installOnce' | 'onOutgoing' | 'setSequencePersistent'> as EngineAccess;

    sequence().__setup?.(engine);
    sequence().__setup?.(engine);

    expect(outgoingHandlers).toHaveLength(1);
  });

  it('adds an increasing _seq to normal outgoing messages', () => {
    const { hook } = installSequence();
    const first = hook({ event: 'message', payload: { text: 'hello' } });
    const second = hook({ event: 'alert', payload: { level: 'warn' } });

    expect(first).toEqual({ text: 'hello', _seq: 1 });
    expect(second).toEqual({ level: 'warn', _seq: 2 });
  });

  it('skips protocol events that start with an underscore', () => {
    const { hook } = installSequence();
    const protocolMessage = hook({ event: '_ack', payload: {} });
    const appMessage = hook({ event: 'message', payload: { text: 'hello' } });

    expect(protocolMessage).toBeUndefined();
    expect(appMessage).toEqual({ text: 'hello', _seq: 1 });
  });

  it('still sequences module-owned outgoing events with a double underscore prefix', () => {
    const { hook } = installSequence();
    const moduleMessage = hook({
      event: '__acme:analytics:flushed',
      payload: { count: 1 },
    });

    expect(moduleMessage).toEqual({ count: 1, _seq: 1 });
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

    const firstMessage = first.hook({ event: 'message', payload: { text: 'one' } });
    const secondMessage = second.hook({ event: 'message', payload: { text: 'two' } });

    expect(firstMessage).toEqual({ text: 'one', _seq: 1 });
    expect(secondMessage).toEqual({ text: 'two', _seq: 2 });
  });
});
