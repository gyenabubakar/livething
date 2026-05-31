/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: InitContext type surface.
 *
 * Verifies that InitContext exposes the correct field types and does NOT
 * expose connection-level APIs that would be invalid before any client connects.
 */

import type { InitContext, KVProvider, Logger, SQLProvider } from '~/context.ts';

// ---------------------------------------------------------------------------
// sql: SQLProvider
// ---------------------------------------------------------------------------

declare const initCtx: InitContext<{ SECRET: string }, { doId: string }>;

const _sql: SQLProvider = initCtx.sql;
void _sql;

initCtx.sql.exec<{ id: string }>('SELECT id FROM t');
initCtx.sql.exec<{ id: string }>('SELECT id FROM t WHERE id = ?', 'abc');

const _txResult: string = initCtx.sql.transaction((tx) => {
  tx.exec<{ n: number }>('SELECT COUNT(*) AS n FROM t');
  return 'done';
});
void _txResult;

// ---------------------------------------------------------------------------
// kv: KVProvider
// ---------------------------------------------------------------------------

const _kv: KVProvider = initCtx.kv;
void _kv;

const _kvGet: Promise<unknown> = initCtx.kv.get('key');
const _kvSet: Promise<void> = initCtx.kv.set('key', 'value', { ttl: 5000 });
const _kvDel: Promise<void> = initCtx.kv.delete('key');
const _kvList: Promise<string[]> = initCtx.kv.list('prefix:');
void [_kvGet, _kvSet, _kvDel, _kvList];

// ---------------------------------------------------------------------------
// env: typed by generic
// ---------------------------------------------------------------------------

const _secret: string = initCtx.env.SECRET;
void _secret;

// @ts-expect-error — unknown env keys are not present
initCtx.env.UNKNOWN_KEY;

// ---------------------------------------------------------------------------
// log: Logger
// ---------------------------------------------------------------------------

const _log: Logger = initCtx.log;
void _log;

initCtx.log.info('setup complete');
initCtx.log.warn('slow query', { ms: 120 });
initCtx.log.error('migration failed', { table: 'users' });

// ---------------------------------------------------------------------------
// platform: typed by generic
// ---------------------------------------------------------------------------

const _platform: { doId: string } = initCtx.platform;
void _platform;

// ---------------------------------------------------------------------------
// InitContext does NOT have connection-level APIs
// ---------------------------------------------------------------------------

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
