import type { EngineCore } from '~/_engine/core.ts';

/** A framework-owned source that may contribute one durable-alarm deadline. */
export type AlarmSource = () => number | null;

type AlarmDeadline = number | null;
type AlarmCore = Pick<EngineCore, 'alarmSources' | 'timers'> &
  Partial<Pick<EngineCore, 'logger' | 'storage'>>;

const ALARM_STATE_TABLE = '__wskit_alarm_state';

interface AlarmSyncState {
  /** Do not retry a failed alarm cycle before this time. */
  retryAt: AlarmDeadline;
  /** The newest desired deadline; `undefined` means no write is queued. */
  desired: AlarmDeadline | undefined;
  /** The in-flight provider operation, if one is applying the desired state. */
  pending: Promise<void> | undefined;
  /** The retry deadline already stored in SQLite. */
  persistedRetryAt: AlarmDeadline;
  /** True after this engine has loaded the shared alarm row from SQLite. */
  durableReady: boolean;
  /** True while the adapter is delivering an alarm callback. */
  delivering: boolean;
  /** A local retry waiting to repeat a failed provider write. */
  providerRetry: ReturnType<typeof setTimeout> | undefined;
  /** The durable retry row created solely because a provider write failed. */
  providerRetryAt: AlarmDeadline;
  /** True after engine shutdown starts. No more adapter writes may begin. */
  stopped: boolean;
}

// TimerProvider methods are asynchronous, but most engine call sites are
// deliberately synchronous (a broadcast, ack, or schedule call). Serializing
// writes here prevents a slower older `setAlarm`/`deleteAlarm` from landing
// after a newer reschedule and leaving the platform with a stale deadline.
const alarmSyncStates = new WeakMap<object, AlarmSyncState>();

function stateFor(core: object): AlarmSyncState {
  let state = alarmSyncStates.get(core);
  if (!state) {
    state = {
      retryAt: null,
      desired: undefined,
      pending: undefined,
      persistedRetryAt: null,
      durableReady: false,
      delivering: false,
      providerRetry: undefined,
      providerRetryAt: null,
      stopped: false,
    };
    alarmSyncStates.set(core, state);
  }
  return state;
}

/** Create the one-row table that keeps framework alarm retries across restarts. */
export function ensureAlarmCoordinatorSchema(core: Pick<EngineCore, 'storage'>): void {
  core.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${ALARM_STATE_TABLE} (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      retry_at INTEGER NOT NULL
    )
  `);
}

/** Load any retry left by an earlier engine instance. */
export function restoreAlarmCoordinator(core: Pick<EngineCore, 'storage'>): void {
  const row = core.storage.sql
    .exec<{ retryAt: number }>(`SELECT retry_at AS retryAt FROM ${ALARM_STATE_TABLE} WHERE id = 1`)
    .one();
  const retryAt = row?.retryAt ?? null;
  const state = stateFor(core);
  state.retryAt = retryAt;
  state.persistedRetryAt = retryAt;
  state.providerRetryAt = null;
  state.durableReady = true;
}

/** Register or replace one framework alarm source on an engine. */
export function registerAlarmSource(
  core: Pick<EngineCore, 'alarmSources'>,
  key: symbol,
  source: AlarmSource,
): void {
  core.alarmSources.set(key, source);
}

/** Mark the coordinator's current retry wake-up as consumed before alarm hooks run. */
export function beginAlarmDelivery(core: object): void {
  const state = stateFor(core);
  state.delivering = true;
  state.retryAt = null;
}

/** Mark the adapter's current alarm callback as complete. */
export function endAlarmDelivery(core: object): void {
  stateFor(core).delivering = false;
}

/**
 * Arm the adapter's single durable alarm for the earliest framework deadline.
 * A source returning `null` has no pending work. Invalid deadlines are ignored
 * so one optional feature cannot corrupt the shared alarm with `NaN`, an unsafe
 * integer, or a non-positive value.
 */
export function rescheduleAlarm(
  core: AlarmCore,
  options: { retryAt?: AlarmDeadline } = {},
): Promise<void> {
  const state = stateFor(core);
  if (state.stopped) return Promise.resolve();
  if ('retryAt' in options) setRetryDeadline(core, state, options.retryAt ?? null);

  const now = Date.now();
  const candidates: number[] = [];
  const sourceFailures: Array<{ name: string; error: unknown }> = [];
  for (const [key, source] of core.alarmSources) {
    let candidate: number | null;
    try {
      candidate = source();
    } catch (error) {
      sourceFailures.push({ name: key.description ?? 'unknown', error });
      continue;
    }
    if (candidate === null || !Number.isSafeInteger(candidate) || candidate <= 0) continue;
    candidates.push(candidate);
  }

  let retryAt = state.retryAt;
  if (sourceFailures.length > 0) {
    const sourceRetryAt = now + 1_000;
    if (retryAt === null || sourceRetryAt < retryAt) {
      setRetryDeadline(core, state, sourceRetryAt);
      retryAt = sourceRetryAt;
    }
    const errors = sourceFailures.map((failure) => failure.error);
    const error =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, '[wskit] one or more durable alarm sources failed');
    core.logger?.error('[wskit] durable alarm source failed; retrying', {
      error: error instanceof Error ? error.message : String(error),
      sources: sourceFailures.map((failure) => failure.name),
    });
  }

  let next: number | null = retryAt;
  for (const candidate of candidates) {
    const effective = retryAt !== null && candidate <= now ? retryAt : candidate;
    if (next === null || effective < next) next = effective;
  }

  state.desired = next;
  if (state.pending) return state.pending;

  const pending = flushAlarm(core, state);
  state.pending = pending;
  observeProviderWrite(core, state, pending);
  return pending;
}

/** Stop local alarm retries and wait for a provider write already in progress. */
export async function stopAlarmCoordinator(core: object): Promise<void> {
  const state = alarmSyncStates.get(core);
  if (!state) return;

  state.stopped = true;
  if (state.providerRetry !== undefined) {
    clearTimeout(state.providerRetry);
    state.providerRetry = undefined;
  }
  await state.pending?.catch(() => {});
}

function setRetryDeadline(core: AlarmCore, state: AlarmSyncState, retryAt: AlarmDeadline): void {
  state.retryAt = retryAt;
  if (state.providerRetryAt !== null && state.providerRetryAt !== retryAt) {
    state.providerRetryAt = null;
  }
  if (!state.durableReady || state.persistedRetryAt === retryAt) return;

  if (retryAt === null) {
    core.storage!.sql.exec(`DELETE FROM ${ALARM_STATE_TABLE} WHERE id = 1`);
  } else {
    core.storage!.sql.exec(
      `INSERT INTO ${ALARM_STATE_TABLE} (id, retry_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET retry_at = excluded.retry_at`,
      retryAt,
    );
  }
  state.persistedRetryAt = retryAt;
}

function setProviderRetryDeadline(core: AlarmCore, state: AlarmSyncState, retryAt: number): void {
  setRetryDeadline(core, state, retryAt);
  state.providerRetryAt = retryAt;
}

function clearProviderRetryAfterSuccessfulWrite(core: AlarmCore, state: AlarmSyncState): void {
  if (state.providerRetryAt === null || state.retryAt !== state.providerRetryAt) return;
  setRetryDeadline(core, state, null);
}

function observeProviderWrite(
  core: AlarmCore,
  state: AlarmSyncState,
  pending: Promise<void>,
): void {
  void pending.catch((error: unknown) => {
    state.pending = undefined;
    core.logger?.error('[wskit] durable alarm reschedule failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!state.stopped) {
      const retryAt = Date.now() + 1_000;
      if (state.retryAt === null || retryAt < state.retryAt) {
        setProviderRetryDeadline(core, state, retryAt);
      }
      if (!state.delivering) scheduleProviderRetry(core, state);
    }
  });
}

function scheduleProviderRetry(core: AlarmCore, state: AlarmSyncState): void {
  if (state.providerRetry !== undefined || state.stopped) return;

  state.providerRetry = setTimeout(() => {
    state.providerRetry = undefined;
    if (state.stopped || state.pending || state.desired === undefined) return;

    const pending = flushAlarm(core, state);
    state.pending = pending;
    observeProviderWrite(core, state, pending);
  }, 1_000);
}

async function flushAlarm(core: AlarmCore, state: AlarmSyncState): Promise<void> {
  while (state.desired !== undefined) {
    if (state.stopped) return;
    const desired = state.desired;
    state.desired = undefined;
    try {
      if (desired === null) {
        await core.timers.deleteAlarm();
      } else {
        await core.timers.setAlarm(desired);
      }
    } catch (error) {
      // Preserve this operation for a later lifecycle-triggered retry unless
      // a newer request has already replaced it while the provider was busy.
      if (state.desired === undefined) state.desired = desired;
      throw error;
    }
  }
  clearProviderRetryAfterSuccessfulWrite(core, state);
  state.pending = undefined;
}
