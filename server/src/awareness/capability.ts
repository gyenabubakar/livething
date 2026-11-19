import { LiveThingConfigError } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { channelOnlyCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import { awarenessMarker } from '~/awareness/marker.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChannelOnlyCapability } from '~/_define/capability.ts';
import type { AwarenessOptions } from '~/awareness/runtime.ts';
import type { ChannelAwarenessReader } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';

type StateOf<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>;
type AwarenessError<M extends string> = { readonly __awarenessError: M };
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `T` when it is a usable awareness `state` schema, else a type whose name says what is
 * wrong. The state is sent as JSON and is the same type on both sides, so the schema must
 * give a plain object and must not change the type of what it checks.
 */
type CheckedAwarenessState<T extends StandardSchemaV1> = 0 extends 1 & StateOf<T>
  ? AwarenessError<'awareness state must not be any'>
  : SameType<StandardSchemaV1.InferInput<T>, StateOf<T>> extends true
    ? [StateOf<T>] extends [object]
      ? [
          Extract<StateOf<T>, readonly unknown[] | Date | Map<unknown, unknown> | Set<unknown>>,
        ] extends [never]
        ? T
        : AwarenessError<'awareness state must be a plain JSON object, not an array, Date, Map or Set'>
      : AwarenessError<'awareness state must be an object type'>
    : AwarenessError<'awareness state schema must not change its type: input and output types must be equal'>;

/**
 * The ctx `check` gets: the sender's channel ctx, whose `ctx.channel.awareness` can read
 * but not set.
 */
type AwarenessCheckCtx<TCtx, TState> = TCtx extends {
  readonly meta: infer TMeta;
  readonly channel: infer TChannel;
}
  ? Omit<TCtx, 'channel'> & {
      readonly channel: TChannel & { readonly awareness: ChannelAwarenessReader<TState, TMeta> };
    }
  : TCtx;

/** A channel's `awareness` option. `TCtx` is the channel's ctx, which types `check`. */
export interface AwarenessConfig<TSchema extends StandardSchemaV1, TCtx = unknown> {
  /** Synchronous schema of one connection's state: a plain JSON object, the same type in and out. */
  readonly state: TSchema & CheckedAwarenessState<TSchema>;
  /**
   * Return `false` to refuse an update. Synchronous, so updates keep their order. Runs on
   * the newest waiting update of each connection, at most once per window. `previous` is
   * the connection's accepted state, or `null`.
   */
  readonly check?: (
    ctx: AwarenessCheckCtx<TCtx, StateOf<TSchema>>,
    state: StateOf<TSchema>,
    previous: StateOf<TSchema> | null,
  ) => boolean;
  /** Batch window in ms, 1 to 10,000. Default 50. */
  readonly windowMs?: number;
  /** Largest state, as UTF-8 bytes of its JSON, up to 65,536. Default 1024. */
  readonly maxBytes?: number;
}

/** The capability `awareness()` returns. Channel-only, like `inbox()`. */
export type AwarenessCapability = ChannelOnlyCapability<{}, never, 'awareness'>;

const AWARENESS_KEYS = ['state', 'check', 'windowMs', 'maxBytes'];
const MAX_WINDOW_MS = 10_000;
const MAX_BYTES = 65_536;

/** Check a channel's `awareness` option and fill in its defaults. */
function resolveAwareness(options: unknown, channel: string): AwarenessOptions {
  if (options === undefined) {
    throw new LiveThingConfigError(
      `${channel}: awareness() needs the channel's 'awareness' option, with a 'state' schema.`,
    );
  }

  const context = `${channel} awareness`;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new LiveThingConfigError(`${context}: pass an object with a 'state' schema.`);
  }

  const unknownKey = Object.keys(options).find((key) => !AWARENESS_KEYS.includes(key));
  if (unknownKey !== undefined) {
    throw new LiveThingConfigError(
      `${context}: there is no '${unknownKey}' option. It takes ${AWARENESS_KEYS.join(', ')}.`,
    );
  }

  const { state, check, windowMs = 50, maxBytes = 1024 } = options as Record<string, unknown>;
  if (typeof state !== 'object' || state === null || !('~standard' in state)) {
    throw new LiveThingConfigError(`${context}: 'state' must be a Standard Schema.`);
  }

  if (check !== undefined && typeof check !== 'function') {
    throw new LiveThingConfigError(`${context}: 'check' must be a function.`);
  }

  for (const [value, field, max] of [
    [windowMs, 'windowMs', MAX_WINDOW_MS],
    [maxBytes, 'maxBytes', MAX_BYTES],
  ] as const) {
    assertPositiveInteger(value, field, context);
    if ((value as number) > max) {
      throw new LiveThingConfigError(
        `${context}: '${field}' must be at most ${max}, got ${String(value)}.`,
      );
    }
  }

  return {
    state: state as AwarenessOptions['state'],
    check: check as AwarenessOptions['check'],
    windowMs: windowMs as number,
    maxBytes: maxBytes as number,
  };
}

/**
 * Live state for each connection in a channel: the message someone is reading, a cursor,
 * a selection. The client sets it, `check` decides, and the other members get it. Only
 * the newest value counts. List it in a channel's own `capabilities`, and set the
 * channel's `awareness` option. The channel needs presence, as awareness sends each
 * member's `meta` to the channel.
 *
 * @example
 * ```ts
 * import { awareness } from '@livething/server/awareness';
 *
 * const rooms = base.channel(['rooms', 'room:{roomId}'], {
 *   capabilities: [awareness()],
 *   awareness: {
 *     state: v.object({ viewingMessageId: v.nullable(v.string()) }),
 *     check: (ctx) => ctx.meta.role !== 'guest',
 *   },
 * });
 * ```
 */
export const awareness = withCapabilityKind(function awareness(): AwarenessCapability {
  const cap = Object.assign(channelOnlyCapability<{}, never, 'awareness'>([]), {
    __buildChannelPrimitive: (config: Record<string, unknown>, channel: string): Primitive =>
      awarenessMarker(resolveAwareness(config.awareness, channel)),
  });

  return stampKind(cap, CAPABILITY_KIND.awareness);
}, CAPABILITY_KIND.awareness);
