import type { SQLProvider, StorageProvider, TimerProvider } from '~/context.ts';

interface RecordedWrite {
  /** Runs the write again. A SQL write gets the provider to run it on. */
  redo(sql: SQLProvider): unknown;
  /** Set when the first attempt at this write was rejected, so a rejected redo is not news. */
  originalFailed?: boolean;
}

interface Failure {
  happened: boolean;
  error?: unknown;
  /** SQLite ended the transaction itself, so the writes were redone outside of it and are saved. */
  redoneOutside: boolean;
}

const READ_STATEMENT = /^\s*(SELECT|EXPLAIN|PRAGMA\b(?![^;]*=))/i;

function pushAll<T>(target: T[] | undefined, items: readonly T[]): void {
  if (!target) return;

  for (const item of items) target.push(item);
}

/**
 * Keeps writes that are not the user's own SQL safe when user code rolls back a
 * `ctx.sql.transaction(...)`.
 *
 * Engine code, `ctx.kv` and user code can share one connection, so a write made
 * while a user transaction is open joins it and is undone by a rollback, while the
 * state the engine keeps in memory is not. The tracker records the engine's SQL
 * writes, its alarm changes and the `ctx.kv` writes made while a user transaction
 * is open. If that transaction rolls back, or its commit fails, it runs them again
 * in order, so they persist as if the user transaction had never been there.
 */
export class UserTransactionTracker {
  /** One list of writes per open user transaction, outermost first. */
  private readonly levels: RecordedWrite[][] = [];

  constructor(private readonly onRedoError: (error: unknown) => void) {}

  /** Whether a user transaction is open right now. */
  get inTransaction(): boolean {
    return this.levels.length > 0;
  }

  /**
   * Run a user's transaction callback and repair the recorded writes if it rolls back.
   *
   * The outermost user transaction runs inside one more transaction, so the rollback
   * and the redo end in a single commit and a crash cannot fall between them.
   */
  run<T>(sql: SQLProvider, fn: () => T): T {
    const writes: RecordedWrite[] = [];
    const nested = this.levels.length > 0;
    this.levels.push(writes);
    const leave = (): void => {
      if (this.levels.at(-1) === writes) this.levels.pop();
    };
    const failure: Failure = { happened: false, redoneOutside: false };

    const attempt = (): T | undefined => {
      try {
        return sql.transaction(fn);
      } catch (error) {
        failure.happened = true;
        failure.error = error;
        leave();
        // A statement such as INSERT OR ROLLBACK makes SQLite end the whole transaction itself.
        // The redo then runs outside of it and is saved at once, so it must not be done again.
        failure.redoneOutside = !this.transactionIsOpen(sql);
        const redone = this.redoAll(sql, writes);
        if (!failure.redoneOutside) pushAll(this.levels.at(-1), redone);

        return undefined;
      }
    };

    let result: T | undefined;
    try {
      result = nested ? attempt() : sql.transaction(attempt);
    } catch (error) {
      // The commit failed, which undoes the recorded writes along with the user's.
      if (!nested && !failure.redoneOutside) this.redoAfterFailedCommit(sql, writes);
      if (!failure.happened) throw error;
    } finally {
      leave();
    }

    if (failure.happened) throw failure.error;

    pushAll(this.levels.at(-1), writes);

    return result as T;
  }

  /** Note one engine statement that ran while a user transaction was open. */
  record(query: string, params: unknown[]): void {
    if (READ_STATEMENT.test(query)) return;

    this.recordOperation((sql) => sql.exec(query, ...params));
  }

  /**
   * Note a write that must run again after a rollback. It must be safe to run twice.
   * Pass the promise of the first attempt if it has one, so a rejection is not reported twice.
   */
  recordOperation(redo: RecordedWrite['redo'], original?: Promise<unknown>): void {
    const level = this.levels.at(-1);
    if (!level) return;

    const write: RecordedWrite = { redo };
    level.push(write);
    original?.catch(() => {
      write.originalFailed = true;
    });
  }

  /**
   * Run an engine transaction. If it fails, forget the writes it recorded. If it succeeds,
   * keep its writes together, so its SQL is done again as one transaction, all or nothing.
   * A kv or alarm write in the group is not undone if a later write in it fails.
   */
  scope<T>(run: () => T): T {
    const writes = this.levels.at(-1);
    const mark = writes?.length ?? 0;
    let result: T;
    try {
      result = run();
    } catch (error) {
      if (writes) writes.length = mark;
      throw error;
    }

    if (writes && writes.length - mark > 1) {
      const group = writes.splice(mark);
      writes.push({
        redo: (sql) =>
          sql.transaction(() => {
            for (const write of group) this.redoOne(sql, write);
          }),
      });
    }

    return result;
  }

  /**
   * Whether a transaction is open on the connection. SQLite refuses to start a transaction
   * inside another one. A provider that refuses to start one for another reason, such as
   * Durable Objects, counts as open.
   */
  private transactionIsOpen(sql: SQLProvider): boolean {
    try {
      sql.exec('BEGIN');
    } catch {
      return true;
    }

    sql.exec('ROLLBACK');

    return false;
  }

  private report(error: unknown): void {
    try {
      this.onRedoError(error);
    } catch {
      // A failing error handler must not hide the user's error or stop the other writes.
    }
  }

  /** Run every write again. A write that fails is reported and does not stop the rest. */
  private redoAll(sql: SQLProvider, writes: readonly RecordedWrite[]): RecordedWrite[] {
    const done: RecordedWrite[] = [];
    for (const write of writes) {
      try {
        this.redoOne(sql, write);
        done.push(write);
      } catch (error) {
        this.report(error);
      }
    }

    return done;
  }

  /** Run one write again. A rejection that comes later is reported, unless it failed the first time too. */
  private redoOne(sql: SQLProvider, write: RecordedWrite): void {
    const outcome = write.redo(sql);
    if (outcome instanceof Promise) {
      outcome.catch((error: unknown) => {
        if (!write.originalFailed) this.report(error);
      });
    }
  }

  private redoAfterFailedCommit(sql: SQLProvider, writes: readonly RecordedWrite[]): void {
    if (writes.length === 0) return;

    try {
      sql.transaction(() => this.redoAll(sql, writes));
    } catch (error) {
      this.report(error);
    }
  }
}

/** The storage that engine code uses. It reports its writes to the tracker. */
export function createEngineStorage(
  storage: StorageProvider,
  tracker: UserTransactionTracker,
): StorageProvider {
  const sql: SQLProvider = {
    exec<TRow = unknown>(query: string, ...params: unknown[]) {
      const result = storage.sql.exec<TRow>(query, ...params);
      tracker.record(query, params);
      return result;
    },
    transaction(fn) {
      return tracker.scope(() => storage.sql.transaction(fn));
    },
    limits: storage.sql.limits,
  };

  return { sql, kv: storage.kv };
}

/**
 * The timers that engine code uses. On some platforms a rolled-back transaction
 * also undoes alarm changes, so the tracker records them.
 */
export function createEngineTimers(
  timers: TimerProvider,
  tracker: UserTransactionTracker,
): TimerProvider {
  return {
    setAlarm(timeMs) {
      const outcome = timers.setAlarm(timeMs);
      tracker.recordOperation(() => timers.setAlarm(timeMs));
      return outcome;
    },
    deleteAlarm() {
      const outcome = timers.deleteAlarm();
      tracker.recordOperation(() => timers.deleteAlarm());
      return outcome;
    },
    getAlarm: () => timers.getAlarm(),
  };
}
