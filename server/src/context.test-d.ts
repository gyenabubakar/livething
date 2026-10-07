/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: InitContext type surface.
 *
 * Verifies that InitContext exposes the correct field types and does NOT
 * expose connection-level APIs that would be invalid before any client connects.
 */

import type { InitContext, KVProvider, Logger, SqlLimits, SQLProvider } from '~/context.ts';

declare const initCtx: InitContext<{ doId: string }>;

const _sql: SQLProvider = initCtx.sql;
void _sql;

initCtx.sql.exec<{ id: string }>('SELECT id FROM t');
initCtx.sql.exec<{ id: string }>('SELECT id FROM t WHERE id = ?', 'abc');

const _limits: SqlLimits = initCtx.sql.limits;
void _limits;

const _maxBoundParams: number = initCtx.sql.limits.maxBoundParams;
const _maxStatementBytes: number = initCtx.sql.limits.maxStatementBytes;
const _maxValueBytes: number = initCtx.sql.limits.maxValueBytes;
void [_maxBoundParams, _maxStatementBytes, _maxValueBytes];

// @ts-expect-error — limits is readonly, not assignable
initCtx.sql.limits = { maxBoundParams: 1, maxStatementBytes: 1, maxValueBytes: 1 };

// SQLProvider requires `limits` — omitting it is a type error.
declare const _missingLimits: {
  exec: SQLProvider['exec'];
  transaction: SQLProvider['transaction'];
};
// @ts-expect-error — SQLProvider requires `limits`, not present here
const _notASqlProvider: SQLProvider = _missingLimits;
void _notASqlProvider;

const _txResult: string = initCtx.sql.transaction(() => {
  initCtx.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM t');
  return 'done';
});
void _txResult;

// The callback takes no `tx` argument: queries inside it use `ctx.sql`, so a callback that
// requires one must not type-check.
// @ts-expect-error — transaction() passes no argument to its callback
initCtx.sql.transaction((tx: SQLProvider) => tx.exec('SELECT 1'));

const _kv: KVProvider = initCtx.kv;
void _kv;

const _kvGet: Promise<unknown> = initCtx.kv.get('key');
const _kvSet: Promise<void> = initCtx.kv.set('key', 'value', { ttl: 5000 });
const _kvDel: Promise<void> = initCtx.kv.delete('key');
const _kvList: Promise<string[]> = initCtx.kv.list('prefix:');
void [_kvGet, _kvSet, _kvDel, _kvList];

const _log: Logger = initCtx.log;
void _log;

initCtx.log.info('setup complete');
initCtx.log.warn('slow query', { ms: 120 });
initCtx.log.error('migration failed', { table: 'users' });

const _platform: { doId: string } = initCtx.platform;
void _platform;

// @ts-expect-error — no send on InitContext
initCtx.send('evt', {});

// @ts-expect-error — no broadcast on InitContext
initCtx.broadcast('evt', {});

// @ts-expect-error — no id on InitContext
initCtx.id;

// @ts-expect-error — no close on InitContext
initCtx.close();

// @ts-expect-error — no schedule on InitContext
initCtx.schedule('task', { time: Date.now() });
