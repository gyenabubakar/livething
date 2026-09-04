import type { EngineCore } from '~/_engine/core.ts';

/** A framework-owned source that may contribute one durable-alarm deadline. */
export type AlarmSource = () => number | null;

type AlarmDeadline = number | null;

interface AlarmSyncState {
  /** Do not retry a failed alarm cycle before this time. */
  retryAt: AlarmDeadline;
  /** The newest desired deadline; `undefined` means no write is queued. */
  desired: AlarmDeadline | undefined;
  /** The in-flight provider operation, if one is applying the desired state. */
  pending: Promise<void> | undefined;
}

// TimerProvider methods are asynchronous, but most engine call sites are
// deliberately synchronous (a broadcast, ack, or schedule call). Serializing
// writes here prevents a slower older `setAlarm`/`deleteAlarm` from landing
// after a newer reschedule and leaving the platform with a stale deadline.
const alarmSyncStates = new WeakMap<object, AlarmSyncState>();

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
  const state = alarmSyncStates.get(core);
  if (state) state.retryAt = null;
}

/**
 * Arm the adapter's single durable alarm for the earliest framework deadline.
 * A source returning `null` has no pending work. Invalid deadlines are ignored
 * so one optional feature cannot corrupt the shared alarm with `NaN`, an unsafe
 * integer, or a non-positive value.
 */
export function rescheduleAlarm(
  core: Pick<EngineCore, 'alarmSources' | 'timers'>,
  options: { retryAt?: AlarmDeadline } = {},
): Promise<void> {
  let state = alarmSyncStates.get(core);
  if (!state) {
    state = { retryAt: null, desired: undefined, pending: undefined };
    alarmSyncStates.set(core, state);
  }
  if ('retryAt' in options) state.retryAt = options.retryAt ?? null;

  const retryAt = state.retryAt;
  const now = Date.now();
  let next: number | null = retryAt;
  for (const source of core.alarmSources.values()) {
    const candidate = source();
    if (candidate === null || !Number.isSafeInteger(candidate) || candidate <= 0) continue;
    const effective = retryAt !== null && candidate <= now ? retryAt : candidate;
    if (next === null || effective < next) next = effective;
  }

  state.desired = next;
  if (state.pending) return state.pending;

  const pending = flushAlarm(core, state);
  state.pending = pending;
  void pending.catch((error: unknown) => {
    // There is no synchronous way for a TimerProvider Promise rejection to
    // reach a caller that only asked to reschedule. Keep the desired deadline
    // queued so the next engine lifecycle event can retry it, and make the
    // failure observable without creating an unhandled rejection.
    state!.pending = undefined;
    const logger = (core as unknown as Partial<Pick<EngineCore, 'logger'>>).logger;
    logger?.error('[wskit] durable alarm reschedule failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return pending;
}

async function flushAlarm(core: Pick<EngineCore, 'timers'>, state: AlarmSyncState): Promise<void> {
  while (state.desired !== undefined) {
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
  state.pending = undefined;
}
