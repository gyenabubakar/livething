/* oxlint-disable @typescript-eslint/no-explicit-any */
import { LiveThingConfigError } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { assertNonReservedEventName } from '~/event-name.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';
import { registerUploadHandler } from './registry.ts';

/** One piece of an upload, as `run` reads it. */
export interface UploadPiece {
  /** The piece's bytes. */
  readonly bytes: Uint8Array;
  /** Where the piece starts in the whole upload, in bytes. */
  readonly offset: number;
}

/**
 * `ctx.upload.state`, when the handler has a `state` schema. Without one the handler keeps no
 * state, so `ctx.upload` has no `state` to read.
 */
type UploadStateField<TStateSchema> = TStateSchema extends StandardSchemaV1
  ? {
      /**
       * The state saved with the last saved offset, checked with the `state` schema when
       * LiveThing read it back. `undefined` when none was saved, or when the stored state
       * failed the schema. In `run`, `saved()` does not change it.
       */
      readonly state: StandardSchemaV1.InferOutput<TStateSchema> | undefined;
    }
  : {};

/** The `ctx.upload` an upload's `run` gets. `TStateSchema` is the handler's `state` schema. */
export type UploadRunHandle<TStateSchema extends Validator | undefined = undefined> = {
  /** Where this run starts: 0 for a new upload, the saved offset for a resumed one. */
  readonly savedThrough: number;
  /**
   * Say how many bytes are really stored, so a resume starts there. With a `state` schema,
   * give `state` to keep a small JSON value with it, such as a multipart upload ID. The
   * offset and the state are written in one SQL write. Throws a `RangeError` when the offset
   * goes back, is past the bytes `run` has read, or the state is over 64 KiB.
   */
  saved(
    offset: number,
    ...options: TStateSchema extends StandardSchemaV1
      ? [options?: { state: StandardSchemaV1.InferInput<TStateSchema> }]
      : []
  ): void;
  /** Fires when the client cancels, the connection closes, or a resume takes over. */
  readonly signal: AbortSignal;
} & UploadStateField<TStateSchema>;

/** The `ctx.upload` that `onDiscard` gets: what the record kept. */
export type UploadDiscardHandle<TStateSchema extends Validator | undefined = undefined> = {
  /** The last saved offset. */
  readonly savedThrough: number;
} & UploadStateField<TStateSchema>;

/** The resolved options of one upload handler. */
interface UploadOptions {
  /** The most bytes the whole upload may have. */
  readonly maxBytes: number;
  /** The biggest piece the client may send. */
  readonly pieceBytes: number;
  /** The most bytes the client may have sent past what `run` has read. */
  readonly windowBytes: number;
}

/**
 * The primitive `base.binary.upload(...)` builds. The engine routes its start frame through
 * the intercepts and the input check, then hands it to the upload runtime.
 */
export interface UploadPrimitive extends Primitive<'upload'>, UploadOptions {
  readonly event: string;
  readonly validator?: Validator;
  /** The `state` schema, which checks a stored state when LiveThing reads it back. */
  readonly stateValidator?: Validator;
  /** Upload frames are binary. */
  readonly binary: true;
  readonly run: (ctx: any, input: any, pieces: AsyncIterable<UploadPiece>) => unknown;
  readonly onDiscard?: (ctx: any, input: any) => unknown;
}

export type AnyUpload = UploadPrimitive;

/** The config `base.binary.upload(...)` takes, before its options are checked. */
export interface UploadBuildConfig {
  input?: Validator;
  state?: Validator;
  maxBytes?: number;
  pieceBytes?: number;
  windowBytes?: number;
  run: UploadPrimitive['run'];
  onDiscard?: UploadPrimitive['onDiscard'];
}

const KiB = 1024;
const MiB = 1024 * KiB;

/** The defaults of an upload handler. */
const UPLOAD_DEFAULTS: UploadOptions = {
  maxBytes: 100 * MiB,
  pieceBytes: 256 * KiB,
  windowBytes: 2 * MiB,
};

function positiveInteger(value: unknown, name: string, method: string): number | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LiveThingConfigError(
      `${method}: '${name}' must be a positive integer, got ${String(value)}.`,
    );
  }

  return value;
}

const UPLOAD_KEY = Symbol('upload');

/** Build the primitive of one `base.binary.upload(...)` handler. */
export function upload(event: string, config: UploadBuildConfig): UploadPrimitive {
  const method = `base.binary.upload('${event}')`;
  assertNonReservedEventName(event, 'binary.upload');
  if (typeof config?.run !== 'function') {
    throw new LiveThingConfigError(`${method}: 'run' must be a function.`);
  }

  if (config.onDiscard !== undefined && typeof config.onDiscard !== 'function') {
    throw new LiveThingConfigError(`${method}: 'onDiscard' must be a function.`);
  }

  // A bad `state` would fail every check when a state is read back, and discard the uploads.
  if (
    config.state !== undefined &&
    typeof (config.state as Partial<Validator> | null)?.['~standard']?.validate !== 'function'
  ) {
    throw new LiveThingConfigError(
      `${method}: 'state' must be a Standard Schema, such as a Valibot or Zod schema.`,
    );
  }

  const options: UploadOptions = {
    maxBytes: positiveInteger(config.maxBytes, 'maxBytes', method) ?? UPLOAD_DEFAULTS.maxBytes,
    pieceBytes:
      positiveInteger(config.pieceBytes, 'pieceBytes', method) ?? UPLOAD_DEFAULTS.pieceBytes,
    windowBytes:
      positiveInteger(config.windowBytes, 'windowBytes', method) ?? UPLOAD_DEFAULTS.windowBytes,
  };

  if (options.windowBytes < options.pieceBytes) {
    throw new LiveThingConfigError(
      `${method}: 'windowBytes' (${options.windowBytes}) must be at least 'pieceBytes' (${options.pieceBytes}), or no piece could ever be sent.`,
    );
  }

  const primitive: UploadPrimitive = {
    __livething: 'upload',
    __identity: [UPLOAD_KEY, event],
    __requires: {},
    __requiresCapabilities: [CAPABILITY_KIND.binary, CAPABILITY_KIND.uploads],
    __setup(engine) {
      const { receiveBytes, postBytes } = engine.getMessageLimits();
      // Over server-sent events a piece goes up in a POST, with the 5-byte batch header too.
      if (postBytes !== undefined && options.pieceBytes + 4 * KiB + 5 > postBytes) {
        throw new LiveThingConfigError(
          `${method}: 'pieceBytes' (${options.pieceBytes}) does not fit sse() maxPostBytes (${postBytes} bytes) with room for the frame's header. Lower 'pieceBytes' or raise maxPostBytes.`,
        );
      }

      // A piece is one binary frame: the 9-byte header and a small envelope, then its bytes.
      if (options.pieceBytes + 4 * KiB > receiveBytes) {
        throw new LiveThingConfigError(
          `${method}: 'pieceBytes' (${options.pieceBytes}) does not fit the adapter's receive limit (${receiveBytes} bytes) with room for the frame's header. Lower 'pieceBytes' or raise the limit.`,
        );
      }

      // Pieces that wait for `run` count against the connection's budget of twice the receive
      // limit. Keep the window in half of it, so the other frames still have room.
      if (options.windowBytes + options.pieceBytes > receiveBytes) {
        throw new LiveThingConfigError(
          `${method}: 'windowBytes' (${options.windowBytes}) and 'pieceBytes' (${options.pieceBytes}) are more than the adapter's receive limit (${receiveBytes} bytes). The pieces in the window count against the connection's budget of twice that limit. Lower 'windowBytes' or raise the limit.`,
        );
      }

      // `this`, not `primitive`: a plugin installs a renamed copy, whose `run` and
      // `onDiscard` run as the plugin.
      registerUploadHandler(engine.storage.sql, this as UploadPrimitive);
    },
    event,
    validator: config.input,
    stateValidator: config.state,
    binary: true,
    run: config.run,
    onDiscard: config.onDiscard,
    ...options,
  };

  return primitive;
}
