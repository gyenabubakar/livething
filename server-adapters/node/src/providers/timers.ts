import type { Logger, SQLProvider, TimerProvider } from '@wskit/server/adapters';

const ALARM_TABLE = '__wskit_node_alarm';
const MAX_TIMEOUT_MS = 2_147_483_647;
const ALARM_RETRY_DELAY_MS = 1_000;

interface AlarmRecord {
  timeMs: number;
  generation: number;
}

/** Timer provider plus the lifecycle controls used by the Node server. */
export interface NodeTimers extends TimerProvider {
  start(onAlarm: () => Promise<void>): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
}

/** Creates a durable alarm backed by the adapter's SQL provider. */
export function createTimers(sql: SQLProvider, logger?: Logger): NodeTimers {
  let tableReady = false;
  let started = false;
  let onAlarm: (() => Promise<void>) | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const inFlight = new Set<Promise<void>>();

  async function ensureTable(): Promise<void> {
    if (tableReady) return;

    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ALARM_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        time_ms INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0
      )`,
    );

    const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${ALARM_TABLE})`).toArray();

    if (!columns.some((column) => column.name === 'generation')) {
      sql.exec(`ALTER TABLE ${ALARM_TABLE} ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`);
    }

    tableReady = true;
  }

  async function setAlarm(timeMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeMs) || timeMs <= 0) {
      throw new RangeError('[wskit] Node alarm time must be a positive safe integer.');
    }

    await ensureTable();

    sql.exec(
      `INSERT INTO ${ALARM_TABLE} (id, time_ms, generation) VALUES (1, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         time_ms = excluded.time_ms,
         generation = generation + 1`,
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
    return (await getAlarmRecord())?.timeMs ?? null;
  }

  async function getAlarmRecord(): Promise<AlarmRecord | null> {
    await ensureTable();

    return sql
      .exec<AlarmRecord>(`SELECT time_ms AS timeMs, generation FROM ${ALARM_TABLE} WHERE id = 1`)
      .one();
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

  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  async function armStoredAlarm(): Promise<void> {
    clearTimeoutIfSet();

    const deadline = await getAlarm();
    if (!started || deadline === null) return;

    // Node timers cannot represent delays larger than a signed 32-bit integer.
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, deadline - Date.now()));

    timeout = setTimeout(() => {
      timeout = undefined;
      runAlarmInBackground();
    }, delay);
  }

  function retryAlarmDelivery(error: unknown): void {
    logger?.error('[wskit] Node durable alarm delivery failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (started) {
      clearTimeoutIfSet();
      timeout = setTimeout(() => {
        timeout = undefined;
        runAlarmInBackground();
      }, ALARM_RETRY_DELAY_MS);
    }
  }

  function runAlarmInBackground(): void {
    const callback = onAlarm;
    const task = runAlarm(callback);
    inFlight.add(task);
    void task.then(
      () => {
        inFlight.delete(task);
      },
      (error: unknown) => {
        inFlight.delete(task);
        retryAlarmDelivery(error);
      },
    );
  }

  async function runAlarm(callback: (() => Promise<void>) | undefined): Promise<void> {
    if (!started || callback === undefined) return;

    const alarm = await getAlarmRecord();
    if (alarm === null) return;

    if (alarm.timeMs > Date.now()) {
      await armStoredAlarm();
      return;
    }

    await callback();

    const delivered = sql
      .exec<{ generation: number }>(
        `DELETE FROM ${ALARM_TABLE}
         WHERE id = 1 AND generation = ?
         RETURNING generation`,
        alarm.generation,
      )
      .one();
    if (delivered === null) {
      await armStoredAlarm();
    }
  }

  function clearTimeoutIfSet(): void {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  }

  return { setAlarm, deleteAlarm, getAlarm, start, stop, drain };
}
