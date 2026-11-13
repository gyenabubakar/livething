/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  assertSynchronousResult,
  Disconnected,
  DurableStreamRequiresUser,
  LiveThingConfigError,
  UploadAborted,
  utf8ByteLength,
  ValidationFailed,
} from '@livething/core';
import { connectionCall, withConnectionCall } from '~/_engine/async-context.ts';
import type { LiveThingError, UploadAbortedReason } from '@livething/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { EngineAccess } from '~/_engine/access.ts';
import type {
  PendingUploadStart,
  UploadPieceOptions,
  UploadService,
  UploadStartOptions,
} from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Validator } from '~/types.ts';
import { uploadHandler } from './registry.ts';
import {
  deleteUpload,
  dueUploads,
  finishUpload,
  insertUpload,
  markUploadDiscarding,
  nextUploadDeadlines,
  purgeUploadsOfUser,
  readUpload,
  saveUploadProgress,
  touchUpload,
} from './storage.ts';
import type { SqlExec, UploadKey, UploadRow, UploadTimes } from './storage.ts';
import type { UploadPiece, UploadPrimitive, UploadRunHandle } from './upload.ts';

/** The most UTF-8 bytes of JSON that `ctx.upload.saved(offset, { state })` keeps. */
const MAX_STATE_BYTES = 64 * 1024;

/** How often a running upload refreshes its row's `updated_at`, so it does not look idle. */
const TOUCH_EVERY_MS = 60_000;

/**
 * How many due rows one sweep handles. The next alarm takes the rest.
 * ponytail: the deadline is a CASE over `updated_at`, so the sweep and the alarm scan the table;
 * add a stored `due_at` column with an index if a server keeps many uploads.
 */
const SWEEP_LIMIT = 100;

/**
 * How long a stop waits for `run` to settle before the upload continues without it. A `run` that
 * stops on its signal settles at once; this is for one that does not. It must stay well under
 * the client's 30 s wait for the first answer, since a resume can wait this long for the old run.
 */
const STOP_GRACE_MS = 10_000;

/** The config error of an async `state` schema, told apart from one the app's `onDiscard` throws. */
class AsyncStateSchemaError extends LiveThingConfigError {}

/** A state's JSON, checked with a `state` schema: its value, or the issues. */
type StateCheck = { ok: true; value: unknown } | { ok: false; issues: string[] };

/**
 * Check a state in its JSON form with the handler's `state` schema, the same way when it is
 * saved and when it is read back. A schema that throws, or that breaks the Standard Schema
 * contract, fails the check. An async schema throws `AsyncStateSchemaError`.
 */
function checkStateJson(schema: Validator, event: string, json: string): StateCheck {
  let returned: ReturnType<StandardSchemaV1['~standard']['validate']>;
  try {
    returned = schema['~standard'].validate(JSON.parse(json));
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }

  let result: StandardSchemaV1.Result<unknown>;
  try {
    result = assertSynchronousResult(returned, `binary.upload('${event}') state`, 'validator');
  } catch {
    throw new AsyncStateSchemaError(
      `binary.upload('${event}'): the 'state' schema must be synchronous. LiveThing checks a stored state while it holds the upload, also when the server starts, so the check cannot wait.`,
    );
  }

  if (typeof result !== 'object' || result === null) return brokenResult();

  if (result.issues === undefined) return { ok: true, value: result.value };

  if (!Array.isArray(result.issues)) return brokenResult();

  const issues: string[] = [];
  for (const issue of result.issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) return brokenResult();

    issues.push(String((issue as { message?: unknown }).message));
  }

  return { ok: false, issues };
}

function brokenResult(): StateCheck {
  return { ok: false, issues: ["The 'state' schema returned no valid result."] };
}

/** A start frame being handled, as the upload service tracks it for cancels. */
interface PendingStart extends PendingUploadStart {
  cancelled: boolean;
}

/** The most uploads one connection is told are not running here. */
const MAX_TOLD_PER_CONNECTION = 32;

/**
 * Why a running upload stopped before `run` settled:
 * - `disconnect`: its connection closed. The upload can resume.
 * - `taken-over`: a newer start of the same upload replaced it. The upload resumes there.
 * - `cancelled`: the client cancelled. The cancel discards the record.
 * - `purged`: the user was purged. The sweep discards the record.
 * - `failed`: the client broke the protocol. The upload fails and is discarded.
 */
type StopReason = 'disconnect' | 'taken-over' | 'cancelled' | 'purged' | 'failed';

interface QueuedPiece {
  bytes: Uint8Array;
  offset: number;
  /** Settles the piece's frame, which gives its bytes back to the connection. */
  release: () => void;
}

interface Session {
  key: string;
  userId: string;
  uploadId: string;
  connection: RuntimeConnection;
  upload: UploadPrimitive;
  /** The total size the start frame announced, or `null`. */
  size: number | null;
  savedThrough: number;
  state: unknown;
  /** The offset after the last byte received. */
  received: number;
  /** The offset after the last byte `run` has read. */
  read: number;
  /** The `seq` of the last piece received in this session. */
  seq: number;
  /** The total from the client's `__uploadEnd__`, once it came. */
  endAt?: number;
  queue: QueuedPiece[];
  /** Wakes the pieces iterator when it waits for a piece, the end, or a stop. */
  wake?: () => void;
  controller: AbortController;
  stopReason?: StopReason;
  /** The error a `failed` upload sends to the client. */
  failure?: LiveThingError;
  touchedAt: number;
  /** Settles once `run` has settled and the session has cleaned up. */
  finished: Promise<void>;
  /** Set when `run` did not stop in time: whatever it does later is ignored. */
  detached?: boolean;
}

/** Where a frame for one upload goes: its connection, and its id for the metadata. */
type UploadTarget = Pick<Session, 'connection' | 'uploadId'>;

/** The options of `ctx.upload.saved()`. */
interface SavedOptions {
  state?: unknown;
}

/** A stored state read back: `ok` is false when it failed the `state` schema. */
interface CheckedState {
  ok: boolean;
  state: unknown;
}

/** What `run` must return. */
interface RunResult {
  info: unknown;
}

function sessionKey(userId: string, uploadId: string): string {
  return `${userId}\u0000${uploadId}`;
}

/** Whether `info` can be a reply's info: a plain object or `null`. */
function isReplyInfo(info: unknown): boolean {
  if (info === null) return true;

  if (typeof info !== 'object' || Array.isArray(info)) return false;

  const proto = Object.getPrototypeOf(info);
  return proto === Object.prototype || proto === null;
}

/** The upload runtime of one engine: the dispatch service, and the hooks that clean up. */
export interface Uploads {
  service: UploadService;
  /** Stop the uploads a closed connection was running. They can resume. */
  connectionClosed(connectionId: string): void;
  /** Stop a purged user's uploads and mark their records for `onDiscard`. */
  purgeUser(userId: string): void;
  /** Expire idle uploads, drop old done rows, and retry `onDiscard`. */
  sweep(): Promise<void>;
  /** When the sweep next has work, or `null`. */
  nextDeadline(): number | null;
}

export function createUploads(engine: EngineAccess, times: UploadTimes): Uploads {
  const sql = engine.storage.sql as unknown as SqlExec;
  const logger = engine.getLogger?.();
  const sessions = new Map<string, Session>();
  function send(session: Session, event: string, payload: Record<string, unknown>): void {
    if (session.connection.closing) return;

    sendTo(session, event, payload);
  }

  function sendTo(target: UploadTarget, event: string, payload: Record<string, unknown>): void {
    engine.sendProtocolFrame(target.connection.id, {
      event,
      payload,
      livething: { uploadId: target.uploadId },
    });
  }

  /** The session keys each connection was already told are not running here. */
  const interruptedTold = new Map<string, Set<string>>();
  /**
   * The start frames each `${connection id}\0${session key}` has being handled, oldest first.
   * A cancel marks the ones that are pending when it comes.
   */
  const pendingStarts = new Map<string, PendingStart[]>();

  /**
   * Tell a connection, once, that the upload it sends pieces for is not running here, for
   * example after a Durable Object restarted. Its client starts the upload again. Each
   * connection is told about at most `MAX_TOLD_PER_CONNECTION` uploads, so a client that
   * makes up ids cannot grow this memory or get a reply for each one.
   */
  function tellInterrupted(connection: RuntimeConnection, uploadId: string): void {
    if (!connection.userId || connection.closing) return;

    let told = interruptedTold.get(connection.id);
    if (!told) {
      told = new Set();
      interruptedTold.set(connection.id, told);
    }

    const key = sessionKey(connection.userId, uploadId);
    if (told.has(key) || told.size >= MAX_TOLD_PER_CONNECTION) return;

    told.add(key);
    sendTo({ connection, uploadId }, '__error__', {
      code: UploadAborted.code,
      detail: { reason: 'interrupted' },
    });
  }

  function sendAck(session: Session, first: boolean): void {
    send(session, '__uploadAck__', {
      receivedThrough: session.read,
      savedThrough: session.savedThrough,
      ...(first
        ? { pieceBytes: session.upload.pieceBytes, windowBytes: session.upload.windowBytes }
        : {}),
    });
  }

  /** Stop a running session, and wait until its `run` has settled. */
  async function stopSession(session: Session, reason: StopReason): Promise<void> {
    if (!session.stopReason) {
      session.stopReason = reason;
      const error =
        reason === 'disconnect'
          ? Disconnected()
          : (session.failure ??
            UploadAborted({
              reason: reason === 'purged' ? 'gone' : (reason as UploadAbortedReason),
            }));
      session.controller.abort(error);
      for (const piece of session.queue.splice(0)) piece.release();
      session.wake?.();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<'grace-over'>((resolve) => {
      timer = setTimeout(() => resolve('grace-over'), STOP_GRACE_MS);
    });
    const outcome = await Promise.race([session.finished, graceOver]);
    clearTimeout(timer);
    if (outcome === 'grace-over') detach(session);
  }

  /**
   * Let go of a run that does not stop: it ignores its signal and waits on something else.
   * The upload can start again, and what the old run does later is ignored.
   */
  function detach(session: Session): void {
    if (session.detached) return;

    session.detached = true;
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    for (const piece of session.queue.splice(0)) piece.release();
    logger?.error(
      `[livething] binary.upload('${session.upload.event}'): run did not stop within ${STOP_GRACE_MS / 1000} s of its signal, so LiveThing stopped waiting for it.`,
      { uploadId: session.uploadId },
    );
    // Nobody else discards a failed upload; a purged one waits for the sweep, which skipped it
    // while it ran.
    if (session.stopReason === 'failed') void discardNow(session);
    else engine.rescheduleAlarm();
  }

  /**
   * Fail an upload the client broke. The client hears at once; `run` gets the stop, and the
   * record is discarded once `run` has settled.
   */
  async function fail(runtime: any, session: Session, reason: UploadAbortedReason): Promise<void> {
    if (session.stopReason) return;

    session.failure = UploadAborted({ reason });
    void stopSession(session, 'failed');
    await runtime.handleRuntimeError(session.connection, {
      error: session.failure,
      event: session.upload.event,
      routing: { uploadId: session.uploadId },
    });
  }

  /**
   * Read a record's state back, checked with the handler's `state` schema: an older deploy may
   * have saved it with another schema. A state that fails the check reads as `undefined`, and
   * LiveThing warns. Without a schema the handler keeps no state.
   *
   * The schema must be synchronous: this runs while LiveThing holds the upload, and in the
   * sweep at server start, so it must not wait. An async schema throws a
   * `LiveThingConfigError`, and the record is left as it is.
   */
  function readState(
    handler: UploadPrimitive | undefined,
    row: Pick<UploadRow, 'event' | 'uploadId' | 'state'>,
  ): CheckedState {
    const schema = handler?.stateValidator;
    if (row.state === null || !schema) return { ok: true, state: undefined };

    const checked = checkStateJson(schema, row.event, row.state);
    if (checked.ok) return { ok: true, state: checked.value };

    const { issues } = checked;
    logger?.warn(
      `[livething] binary.upload('${row.event}'): the stored state of upload '${row.uploadId}' failed the 'state' schema, so it reads as undefined. An older deploy may have saved it with another schema.`,
      { event: row.event, uploadId: row.uploadId, issues },
    );

    return { ok: false, state: undefined };
  }

  /**
   * Run `onDiscard` for a record that is `discarding`, then delete it. On a throw the sweep
   * tries again. `checked` is the state when the caller has already read it back.
   */
  async function discard(row: UploadRow, checked?: CheckedState): Promise<void> {
    const handler = uploadHandler(sql, row.event);
    if (handler?.onDiscard) {
      const ctx = engine.buildConnectionlessContext() as Record<PropertyKey, unknown>;
      try {
        ctx.upload = {
          savedThrough: row.savedThrough,
          state: (checked ?? readState(handler, row)).state,
        };
        await handler.onDiscard(ctx, JSON.parse(row.input));
      } catch (error) {
        const message =
          error instanceof AsyncStateSchemaError
            ? `[livething] the 'state' schema of binary.upload('${row.event}') is async, so onDiscard cannot run. Make the schema synchronous and deploy again: the record waits, and the next sweep tries again.`
            : '[livething] an upload onDiscard threw. It runs again on the next sweep.';
        logger?.error(message, {
          event: row.event,
          uploadId: row.uploadId,
          error: error instanceof Error ? error.message : String(error),
        });
        engine.rescheduleAlarm();
        return;
      }
    }

    deleteUpload(sql, row);
    engine.rescheduleAlarm();
  }

  async function discardNow(key: UploadKey): Promise<void> {
    markUploadDiscarding(sql, key, Date.now());
    const row = readUpload(sql, key.userId, key.uploadId);
    if (row?.status === 'discarding') await discard(row);
  }

  function pieces(session: Session): AsyncIterable<UploadPiece> {
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (session.stopReason) throw session.controller.signal.reason;

          const next = session.queue.shift();
          if (next) {
            session.read = next.offset + next.bytes.byteLength;
            next.release();
            const now = Date.now();
            if (now - session.touchedAt >= TOUCH_EVERY_MS) {
              session.touchedAt = now;
              touchUpload(sql, session, now);
            }

            sendAck(session, false);
            yield { bytes: next.bytes, offset: next.offset };
            continue;
          }

          if (session.endAt !== undefined && session.read >= session.endAt) return;

          await new Promise<void>((resolve) => {
            session.wake = resolve;
          });
          session.wake = undefined;
        }
      },
    };
  }

  /**
   * The JSON that `saved()` stores for a state. It checks the state the way a resume will read
   * it back, so a state that would fail there (a `Date`, a `Map`, `NaN`) is never stored.
   */
  function savedStateJson(session: Session, state: unknown): string {
    const method = `[livething] ctx.upload.saved(): binary.upload('${session.upload.event}')`;
    const json = JSON.stringify(state) as string | undefined;
    if (json === undefined) {
      throw new TypeError(`${method}: the state has no JSON form, so it cannot be stored.`);
    }

    const size = utf8ByteLength(json);
    if (size > MAX_STATE_BYTES) {
      throw new RangeError(
        `[livething] ctx.upload.saved(): the state is ${size} bytes of JSON, over the 64 KiB limit.`,
      );
    }

    const checked = checkStateJson(session.upload.stateValidator!, session.upload.event, json);
    if (!checked.ok) {
      throw new TypeError(
        `${method}: the state fails the 'state' schema in its JSON form, the way a resume reads it back: ${checked.issues.join('; ')}`,
      );
    }

    return json;
  }

  function handle(session: Session): UploadRunHandle<Validator> {
    return {
      get savedThrough() {
        return session.savedThrough;
      },
      get state() {
        return session.state;
      },
      get signal() {
        return session.controller.signal;
      },
      saved(offset: number, options?: SavedOptions) {
        // A run that LiveThing stopped waiting for must not write over the record of the run
        // that took its place.
        if (session.detached || sessions.get(session.key) !== session) {
          throw (
            (session.controller.signal.reason as Error | undefined) ??
            new Error('[livething] ctx.upload.saved(): this run of the upload has ended.')
          );
        }

        if (
          typeof offset !== 'number' ||
          !Number.isSafeInteger(offset) ||
          offset < session.savedThrough ||
          offset > session.read
        ) {
          throw new RangeError(
            `[livething] ctx.upload.saved(${String(offset)}): the offset must be a whole number from ${session.savedThrough} (the last saved offset) to ${session.read} (the bytes run has read).`,
          );
        }

        let stateJson: string | null | undefined;
        if (options !== undefined && 'state' in options) {
          if (!session.upload.stateValidator) {
            throw new TypeError(
              `[livething] ctx.upload.saved(): binary.upload('${session.upload.event}') declares no 'state' schema, so it keeps no state. Add a 'state' schema to the handler.`,
            );
          }

          // `undefined` clears the state, so it reads back as `undefined`, not `null`.
          stateJson = options.state === undefined ? null : savedStateJson(session, options.state);
        }

        const now = Date.now();
        saveUploadProgress(sql, session, { savedThrough: offset, state: stateJson, now });
        session.savedThrough = offset;
        session.touchedAt = now;
      },
    };
  }

  /** Run `run` for a session, then store the reply or handle the stop. */
  async function runSession(runtime: any, session: Session, input: unknown): Promise<void> {
    const { connection, upload } = session;
    let reply: string | undefined;
    let info: unknown;
    let thrown: unknown;
    let threw = false;

    try {
      const ctx = runtime.buildConnectionContext(connection, {});
      ctx.upload = handle(session);
      const result = (await withConnectionCall(
        runtime.asyncContext,
        connectionCall(connection.id, {}, () => ctx),
        () => upload.run(ctx, input, pieces(session)),
      )) as Partial<RunResult> | undefined;
      if (typeof result !== 'object' || result === null || !('info' in result)) {
        throw new TypeError(
          `[livething] binary.upload('${upload.event}'): run must return { info }.`,
        );
      }

      if (!isReplyInfo(result.info)) {
        throw new TypeError(
          `[livething] binary.upload('${upload.event}'): the reply's info must be a plain object or null.`,
        );
      }

      info = result.info;
      reply = JSON.stringify(info);
    } catch (error) {
      threw = true;
      thrown = error;
    }

    // A run that did not stop in time was let go: the upload went on without it.
    if (session.detached) return;

    const key = { userId: session.userId, uploadId: session.uploadId };
    // Before anything reschedules the alarm, which skips the uploads still running.
    if (sessions.get(session.key) === session) sessions.delete(session.key);

    // A drop or a takeover stopped `run` before it read every byte, and `run` returned anyway:
    // its reply would mark a part of the file done, so the upload resumes later instead.
    const readAll = session.endAt !== undefined && session.read === session.endAt;
    const stoppedEarly =
      (session.stopReason === 'disconnect' || session.stopReason === 'taken-over') && !readAll;
    if (!threw && stoppedEarly) {
      runtime.logger.warn(
        `[livething] binary.upload('${upload.event}'): run returned after it was stopped, before it read every byte. Its reply is ignored, and the upload resumes from its saved offset. Let the error from the pieces reach the end of run.`,
        { event: upload.event, uploadId: session.uploadId },
      );
    }

    try {
      if (
        !threw &&
        !stoppedEarly &&
        session.stopReason !== 'cancelled' &&
        session.stopReason !== 'purged' &&
        session.stopReason !== 'failed'
      ) {
        // `run` read every byte and finished, even if a stop came after: the upload is done.
        try {
          finishUpload(sql, key, { savedThrough: session.read, reply: reply!, now: Date.now() });
        } catch (error) {
          // The reply could not be stored (for example, over the row limit): the upload fails.
          await runtime.handleRuntimeError(connection, {
            error,
            event: upload.event,
            routing: { uploadId: session.uploadId },
          });
          await discardNow(key);
          return;
        }

        send(session, '__uploadDone__', { info });
        engine.rescheduleAlarm();
        return;
      }

      switch (session.stopReason) {
        case 'disconnect':
        case 'taken-over':
          // The upload resumes later: keep the record.
          touchUpload(sql, key, Date.now());
          engine.rescheduleAlarm();
          return;

        case 'cancelled':
          // The cancel discards the record.
          return;

        case 'purged':
          // The sweep discards the record, now that no run holds it.
          engine.rescheduleAlarm();
          return;

        case 'failed':
          // `fail` already told the client.
          await discardNow(key);
          return;

        case undefined:
          await runtime.handleRuntimeError(connection, {
            error: thrown,
            event: upload.event,
            routing: { uploadId: session.uploadId },
          });
          await discardNow(key);
          return;
      }
    } finally {
      for (const piece of session.queue.splice(0)) piece.release();
    }
  }

  const service: UploadService = {
    async start(runtime: any, connection: RuntimeConnection, options: UploadStartOptions) {
      const { upload, payload, livething } = options;
      const uploadId = livething.uploadId;
      if (uploadId === undefined) {
        throw ValidationFailed({
          event: upload.event,
          issues: [{ message: "An upload's start frame needs 'upload' metadata with an id." }],
        });
      }

      if (!connection.userId) throw DurableStreamRequiresUser();

      const size = livething.uploadSize ?? null;
      if (size !== null && size > upload.maxBytes) throw UploadAborted({ reason: 'too-large' });

      const key = sessionKey(connection.userId, uploadId);
      interruptedTold.get(connection.id)?.delete(key);

      const input = JSON.stringify(payload ?? null);
      const rowKey = { userId: connection.userId, uploadId };

      // This connection's cancel came while an intercept held this start. Check before the
      // takeover: a start sent after the cancel may run now, and must not be stopped.
      if (options.pendingStart?.cancelled) throw UploadAborted({ reason: 'cancelled' });

      // A newer start replaces a running one, but only once that one's `run` has settled.
      for (let running = sessions.get(key); running; running = sessions.get(key)) {
        if (running.connection.id !== connection.id) {
          sendTo(running, '__error__', {
            code: UploadAborted.code,
            detail: { reason: 'taken-over' },
          });
        }

        await stopSession(running, 'taken-over');
      }

      // The cancel can also come while this start waits for the old run.
      if (options.pendingStart?.cancelled) throw UploadAborted({ reason: 'cancelled' });

      if (connection.closing) return;

      let state: unknown;
      let row = readUpload(sql, connection.userId, uploadId);
      if (row) {
        if (row.event !== upload.event || row.input !== input || row.size !== size) {
          throw UploadAborted({ reason: 'input-mismatch' });
        }

        if (row.status === 'discarding') throw UploadAborted({ reason: 'gone' });

        if (row.status === 'done') {
          sendTo({ connection, uploadId }, '__uploadDone__', { info: JSON.parse(row.reply!) });
          return;
        }

        // Synchronous, like everything from the takeover loop to `sessions.set`.
        const checked = readState(upload, row);
        if (!checked.ok) {
          markUploadDiscarding(sql, rowKey, Date.now());
          void discard({ ...row, status: 'discarding' }, checked);
          throw UploadAborted({ reason: 'bad-state' });
        }

        state = checked.state;
      } else {
        const now = Date.now();
        insertUpload(sql, {
          userId: connection.userId,
          uploadId,
          event: upload.event,
          input,
          size,
          updatedAt: now,
        });
        engine.rescheduleAlarm();
        row = readUpload(sql, connection.userId, uploadId)!;
      }

      let finish!: () => void;
      const session: Session = {
        key,
        ...rowKey,
        connection,
        upload,
        size: row.size,
        savedThrough: row.savedThrough,
        state,
        received: row.savedThrough,
        read: row.savedThrough,
        seq: 0,
        queue: [],
        controller: new AbortController(),
        touchedAt: Date.now(),
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };

      sessions.set(key, session);
      sendAck(session, true);
      void runSession(runtime, session, payload).then(finish, (error: unknown) => {
        logger?.error('[livething] an upload stopped with an error', {
          event: upload.event,
          error: error instanceof Error ? error.message : String(error),
        });
        finish();
      });
    },

    async piece(runtime: any, connection: RuntimeConnection, options: UploadPieceOptions) {
      const { event, livething, bytes } = options;
      const session = connection.userId
        ? sessions.get(sessionKey(connection.userId, livething.uploadId!))
        : undefined;
      if (!session) {
        tellInterrupted(connection, livething.uploadId!);
        return;
      }

      // A late piece from a replaced connection, or for an upload that is stopping, has
      // nobody to take it.
      if (session.connection.id !== connection.id || session.stopReason) return;

      const { upload } = session;
      const length = bytes?.byteLength ?? 0;
      if (
        bytes === undefined ||
        event !== upload.event ||
        livething.uploadSeq !== session.seq + 1 ||
        length === 0 ||
        length > upload.pieceBytes ||
        (session.endAt !== undefined && session.received + length > session.endAt)
      ) {
        await fail(runtime, session, 'bad-piece');
        return;
      }

      const offset = session.received;
      session.seq += 1;
      session.received += length;
      if (
        session.received > upload.maxBytes ||
        (session.size !== null && session.received > session.size)
      ) {
        await fail(runtime, session, 'too-large');
        return;
      }

      if (session.received - session.read > upload.windowBytes) {
        await fail(runtime, session, 'window');
        return;
      }

      await new Promise<void>((release) => {
        session.queue.push({ bytes, offset, release });
        session.wake?.();
      });
    },

    async end(runtime: any, connection: RuntimeConnection, frame: Protocol.UploadEndFrame) {
      const session = connection.userId
        ? sessions.get(sessionKey(connection.userId, frame.__livething.uploadId!))
        : undefined;
      if (!session) {
        tellInterrupted(connection, frame.__livething.uploadId!);
        return;
      }

      if (session.connection.id !== connection.id || session.stopReason) return;

      const total = frame.payload.totalBytes;
      if (total > session.upload.maxBytes) {
        await fail(runtime, session, 'too-large');
        return;
      }

      if (
        session.endAt !== undefined ||
        total < session.received ||
        (session.size !== null && total !== session.size)
      ) {
        await fail(runtime, session, 'bad-piece');
        return;
      }

      session.endAt = total;
      session.wake?.();
    },

    async cancel(_runtime: any, connection: RuntimeConnection, frame: Protocol.UploadCancelFrame) {
      if (!connection.userId) return;

      const uploadId = frame.__livething.uploadId!;
      const key = sessionKey(connection.userId, uploadId);
      const running = sessions.get(key);
      if (running) await stopSession(running, 'cancelled');

      const row = readUpload(sql, connection.userId, uploadId);
      if (row && row.status !== 'done') await discardNow(row);
    },

    cancelArrived(connection: RuntimeConnection, uploadId: string) {
      if (!connection.userId) return;

      // The starts from this connection that are being handled now (held by an intercept, or
      // waiting for an older run) refuse. A start that arrives after this cancel does not.
      const entry = `${connection.id}\u0000${sessionKey(connection.userId, uploadId)}`;
      for (const start of pendingStarts.get(entry) ?? []) start.cancelled = true;
    },

    starting(connection: RuntimeConnection, uploadId: string) {
      if (!connection.userId) return undefined;

      const entry = `${connection.id}\u0000${sessionKey(connection.userId, uploadId)}`;
      const start: PendingStart = {
        cancelled: false,
        end() {
          const rest = (pendingStarts.get(entry) ?? []).filter((s) => s !== start);
          if (rest.length > 0) pendingStarts.set(entry, rest);
          else pendingStarts.delete(entry);
        },
      };

      pendingStarts.set(entry, [...(pendingStarts.get(entry) ?? []), start]);

      return start;
    },
  };

  return {
    service,

    connectionClosed(connectionId) {
      for (const session of sessions.values()) {
        if (session.connection.id === connectionId) void stopSession(session, 'disconnect');
      }

      interruptedTold.delete(connectionId);
    },

    purgeUser(userId) {
      for (const session of sessions.values()) {
        if (session.userId !== userId) continue;

        sendTo(session, '__error__', {
          code: UploadAborted.code,
          detail: { reason: 'gone' },
        });
        void stopSession(session, 'purged');
      }

      // Due at once: the first `onDiscard` does not wait for the retry delay.
      purgeUploadsOfUser(sql, userId, Date.now() - times.retryMs);
      engine.rescheduleAlarm();
    },

    async sweep() {
      for (const row of dueUploads(sql, times, { now: Date.now(), limit: SWEEP_LIMIT })) {
        // An upload a connection is still running never expires.
        if (sessions.has(sessionKey(row.userId, row.uploadId))) continue;

        if (row.status === 'done') {
          deleteUpload(sql, row);
          continue;
        }

        markUploadDiscarding(sql, row, Date.now());
        await discard({ ...row, status: 'discarding' });
      }

      engine.rescheduleAlarm();
    },

    nextDeadline() {
      // ponytail: looks at the 32 earliest rows; if all belong to running uploads, the
      // next deadline waits for one of those uploads to end and reschedule.
      for (const next of nextUploadDeadlines(sql, times, 32)) {
        if (!sessions.has(sessionKey(next.userId, next.uploadId))) return next.deadline;
      }

      return null;
    },
  };
}
