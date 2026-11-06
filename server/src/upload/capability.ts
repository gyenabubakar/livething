import { LiveThingConfigError } from '@livething/core';
import { assertConfigShape } from '~/_define/capability-checks.ts';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import { createUploads } from './runtime.ts';
import { ensureUploadSchema } from './storage.ts';
import { upload } from './upload.ts';
import type { UploadTimes } from './storage.ts';
import type { UploadBuildConfig } from './upload.ts';

/** Options for `uploads()`. */
export interface UploadsOptions {
  /**
   * An upload that gets no pieces and no `ctx.upload.saved()` for this long expires: its
   * `onDiscard` runs and its record is deleted. An upload that a connection is running never
   * expires. Default: 24 hours.
   */
  readonly expireAfterMs?: number;
  /**
   * How long a finished upload keeps its reply, so a client that lost the reply in a drop
   * gets it again from `start()`. Default: 10 minutes.
   */
  readonly retentionAfterDoneMs?: number;
}

/** The value `uploads()` returns. List it with `binary()` to get `base.binary.upload(...)`. */
export interface UploadsCapability extends Capability<
  {},
  never,
  'uploads',
  typeof CAPABILITY_KIND.uploads
> {
  /** Build the primitive of one `base.binary.upload(...)` handler. @internal */
  readonly __uploadBuild: (event: string, config: UploadBuildConfig) => Primitive;
}

const HOUR = 60 * 60 * 1000;
const UPLOADS_RUNTIME_KEY = Symbol('livething.uploads');
const UPLOADS_ALARM_KEY = Symbol('livething.uploads-expiry');
const UPLOADS_CONFIG = { hooks: [], options: ['expireAfterMs', 'retentionAfterDoneMs'] };

/** The times one `uploads(...)` set itself. */
type SetTimes = Partial<Pick<UploadTimes, 'idleMs' | 'doneMs'>>;

/**
 * The times of each server's one upload engine, keyed by its SQL handle. The host and its
 * plugins can each list `uploads()`; they share one engine, so they share these times. Each
 * time is set by the `uploads(...)` that gives it; two that give one time different values
 * are refused.
 */
const sharedTimes = new WeakMap<object, { times: UploadTimes; set: SetTimes }>();

function shareTimes(engineSql: object, given: SetTimes): UploadTimes {
  let shared = sharedTimes.get(engineSql);
  if (!shared) {
    shared = { times: { idleMs: 24 * HOUR, doneMs: HOUR / 6, retryMs: 60_000 }, set: {} };
    sharedTimes.set(engineSql, shared);
  }

  for (const field of ['idleMs', 'doneMs'] as const) {
    const value = given[field];
    if (value === undefined) continue;

    const earlier = shared.set[field];
    if (earlier !== undefined && earlier !== value) {
      const option = field === 'idleMs' ? 'expireAfterMs' : 'retentionAfterDoneMs';
      throw new LiveThingConfigError(
        `uploads() is listed more than once with different values of '${option}' (${earlier} and ${value}). The host and its plugins share one upload engine: give each time in one place, and list uploads() with no options elsewhere.`,
      );
    }

    shared.set[field] = value;
    shared.times[field] = value;
  }

  return shared.times;
}

function positiveMs(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LiveThingConfigError(
      `uploads(): '${name}' must be a positive whole number of milliseconds, got ${String(value)}.`,
    );
  }

  return value;
}

/**
 * Turn uploads on. With `binary()`, it adds `base.binary.upload(...)`: a client sends one large
 * file in pieces, with speed control, cancel and resume. LiveThing keeps each upload's record
 * (its input, saved offset and state) in its own SQL table, `__livething_uploads`. Where the
 * bytes go (a disk, S3, R2) is up to your `run`.
 *
 * @example
 * ```ts
 * import { server } from '@livething/server';
 * import { binary } from '@livething/server/binary';
 * import { uploads } from '@livething/server/uploads';
 *
 * const base = server({ capabilities: [binary(), uploads()] });
 * ```
 */
export const uploads = withCapabilityKind(function uploads(
  options: UploadsOptions = {},
): UploadsCapability {
  assertConfigShape(options, UPLOADS_CONFIG, 'uploads()');
  const given: SetTimes = {
    idleMs: positiveMs(options.expireAfterMs, 'expireAfterMs'),
    doneMs: positiveMs(options.retentionAfterDoneMs, 'retentionAfterDoneMs'),
  };

  const runtime = definePrimitive({
    tag: 'uploads-runtime',
    key: UPLOADS_RUNTIME_KEY,
    setup(engine) {
      const shared = shareTimes(engine.storage.sql, given);
      engine.installOnce(UPLOADS_RUNTIME_KEY, () => {
        const running = createUploads(engine, shared);
        engine.setUploadService(running.service);
        engine.onBootSchema(() => ensureUploadSchema(engine.storage.sql as never));
        engine.onBoot(() => running.sweep());
        engine.onConnectionCleanup((connectionId) => running.connectionClosed(connectionId));

        engine.onPurgeUser((_core, userId) => running.purgeUser(userId));
        engine.registerAlarmSource(UPLOADS_ALARM_KEY, () => running.nextDeadline());
        engine.onAlarm(() => running.sweep());
      });
    },
  });

  return stampKind(
    capability<{}, never, 'uploads', typeof CAPABILITY_KIND.uploads>([runtime()], {
      __uploadBuild: upload,
    }),
    CAPABILITY_KIND.uploads,
  ) as UploadsCapability;
}, CAPABILITY_KIND.uploads);

export type { UploadPiece, UploadRunHandle, UploadDiscardHandle } from './upload.ts';
