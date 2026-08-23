import type { Logger, SQLProvider, TimerProvider } from '@wskit/server/adapters';

const ALARM_TABLE = '__wskit_node_alarm';
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Timer provider plus the lifecycle controls used by the Node server. */
export interface NodeTimers extends TimerProvider {
  start(onAlarm: () => Promise<void>): Promise<void>;
  stop(): void;
}

/** Creates a durable alarm backed by the adapter's SQL provider. */
export function createTimers(sql: SQLProvider, logger?: Logger): NodeTimers {
  let tableReady = false;
  let started = false;
  let onAlarm: (() => Promise<void>) | undefined;
  let timeout: NodeJS.Timeout | undefined;

  async function ensureTable(): Promise<void> {
    if (tableReady) return;

    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ALARM_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        time_ms INTEGER NOT NULL
      )`,
    );

    tableReady = true;
  }

  async function setAlarm(timeMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeMs) || timeMs <= 0) {
      throw new RangeError('[wskit] Node alarm time must be a positive safe integer.');
    }

    await ensureTable();

    sql.exec(
      `INSERT INTO ${ALARM_TABLE} (id, time_ms) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET time_ms = excluded.time_ms`,
      timeMs,
    );

    if (started) await armStoredAlarm();
  }

  async function deleteAlarm(): Promise<void> {
    await ensureTable();
    sql.exec(`DELETE FROM ${ALARM_TABLE} WHERE id = 1`);
    clearTimeoutIfSet();
  }

  async function getAlarm(): Promise<number | null> {
    await ensureTable();

    const row = sql
      .exec<{ timeMs: number }>(`SELECT time_ms AS timeMs FROM ${ALARM_TABLE} WHERE id = 1`)
      .one();

    return row?.timeMs ?? null;
  }

  async function start(callback: () => Promise<void>): Promise<void> {
    await ensureTable();
    onAlarm = callback;
    started = true;
    await armStoredAlarm();
  }

  function stop(): void {
    started = false;
    onAlarm = undefined;
    clearTimeoutIfSet();
  }

  async function armStoredAlarm(): Promise<void> {
    clearTimeoutIfSet();

    const deadline = await getAlarm();
    if (!started || deadline === null) return;

    // Node timers cannot represent delays larger than a signed 32-bit integer.
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, deadline - Date.now()));

    timeout = setTimeout(() => {
      timeout = undefined;

      void runAlarm().catch((error: unknown) => {
        logger?.error('[wskit] Node durable alarm failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
  }

  async function runAlarm(): Promise<void> {
    if (!started) return;

    const deadline = await getAlarm();
    if (deadline === null) return;

    if (deadline > Date.now()) {
      await armStoredAlarm();
      return;
    }

    sql.exec(`DELETE FROM ${ALARM_TABLE} WHERE id = 1 AND time_ms = ?`, deadline);
    if ((await getAlarm()) !== null) {
      await armStoredAlarm();
      return;
    }

    await onAlarm?.();
  }

  function clearTimeoutIfSet(): void {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  }

  return { setAlarm, deleteAlarm, getAlarm, start, stop };
}
