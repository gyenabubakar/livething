/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.stream()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/streams'`
 * Adds method: `.stream(eventContract, chunkSchema, options?)`
 *
 * Streams let the server push a sequence of values (chunks) to the client in
 * response to one triggering event from the client. The server side is an
 * `AsyncGenerator` — it `yield`s chunks one by one until done.
 *
 * Calling `.stream()` returns a `StreamBuilder` with its own API:
 *   - `.nudge(contract)` — declare a client→server event the client can send
 *     *while the stream is running* to influence it (e.g. pause, filter)
 *   - `.generate(handler)` — attach the `AsyncGenerator` that produces chunks.
 *     This registers the stream and returns the `StreamBuilder` (not the parent).
 *   - `.done()` — return to the parent builder after `.generate()`.
 *   - `.extract()` — detach as a reusable `GeneratePrimitive`.
 *
 * Setting `options.broadcast = true` fans the stream out to all connections
 * rather than only the triggering connection.
 *
 * This file also exports `StreamBuilder` and uses module augmentation +
 * prototype patching to wire `.stream()` into the existing builders.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import {
  generate as createGenerate,
  nudge as createNudge,
  start as createStart,
  stream as createStream,
} from '~/stream/stream.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamHandlerContext,
  StreamNudgeMessages,
} from '~/stream/stream.ts';
import type { Validator } from '~/types.ts';

/**
 * A sub-builder returned by `.stream()`. Collects nudge declarations and the
 * generator function before packaging them into stream + generate primitives.
 *
 * Type parameters:
 * - `TParentBuilder` — the builder type (ServerBuilder or GroupBuilder) to
 *   return when `.done()` is called.
 * - `TParentState` — the parent's type-level state, used to construct the
 *   correct `ctx` type for the generator.
 * - `TEvent` — the string literal type of the trigger event name.
 * - `TPayload` — the validated type of the trigger payload.
 * - `TChunks` — the type of values the generator yields.
 * - `TNudges` — tuple of nudge declarations added with `.nudge()`.
 */
export class StreamBuilder<
  TParentBuilder,
  TParentState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[] = readonly [],
> {
  /** @internal Reference to the parent builder for `.done()`. */
  readonly _parentBuilder: TParentBuilder;
  /** @internal The parent builder's primitive array for `.generate()` to push into. */
  readonly _parentPrimitives: Primitive[];
  /** @internal The trigger event name. */
  readonly _event: TEvent;
  /** @internal Validator for the trigger payload. */
  readonly _triggerSchema: Validator<TPayload>;
  /** @internal Whether to fan the stream out to all connections. */
  readonly _broadcast: boolean;
  /** @internal Nudge declarations accumulated via `.nudge()`. */
  readonly _nudges: NudgeDeclaration[] = [];

  constructor(
    parentBuilder: TParentBuilder,
    parentPrimitives: Primitive[],
    eventContract: EventContract<TEvent, TPayload>,
    _chunkSchema: Validator<TChunks>,
    options?: { broadcast?: boolean },
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._event = eventContract.event;
    this._triggerSchema = eventContract.schema;
    this._broadcast = options?.broadcast ?? false;
  }

  /**
   * Declare a client→server event that can be sent while this stream is active.
   * The generator receives nudges via `ctx.nudges()` as `yield` return values,
   * allowing the client to send mid-stream signals (e.g. "stop", "change filter").
   */
  nudge<NEvent extends string, NPayload = unknown>(
    eventContract: EventContract<NEvent, NPayload>,
  ): StreamBuilder<
    TParentBuilder,
    TParentState,
    TEvent,
    TPayload,
    TChunks,
    readonly [...TNudges, NudgeDeclaration<NEvent, NPayload>]
  > {
    this._nudges.push(createNudge(eventContract.event, eventContract.schema as any));
    return this as any;
  }

  /**
   * Attach the `AsyncGenerator` that produces the stream's chunks. This
   * immediately registers the stream and generate primitives on the parent
   * builder.
   *
   * The generator receives `ctx` (the handler context extended with
   * `ctx.nudges()`) and the validated trigger `payload`. Each `yield` sends one
   * chunk to the client. The value passed back by the `yield` expression
   * (i.e. the generator's `TNext`) carries the batched nudge messages received
   * since the last yield.
   */
  generate(
    handler: (
      ctx: StreamHandlerContext<HandlerCtxFromState<TParentState>, TNudges>,
      payload: TPayload,
    ) => AsyncGenerator<
      TChunks,
      void,
      TNudges extends readonly [] ? undefined : StreamNudgeMessages<TNudges>
    >,
  ): StreamBuilder<TParentBuilder, TParentState, TEvent, TPayload, TChunks, TNudges> {
    const streamPrimitive = createStream<TEvent, TPayload, TChunks, typeof this._nudges>(
      createStart(this._event, this._triggerSchema as (value: unknown) => TPayload, {
        broadcast: this._broadcast,
      }),
      ...this._nudges,
    );
    const generatePrimitive = createGenerate(streamPrimitive, handler as any);
    this._parentPrimitives.push(streamPrimitive as Primitive);
    this._parentPrimitives.push(generatePrimitive as Primitive);
    return this as any;
  }

  /**
   * Return to the parent builder after calling `.generate()`. This ends the
   * stream sub-builder chain and resumes the parent fluent chain.
   */
  done(): TParentBuilder {
    return this._parentBuilder;
  }

  /**
   * Package the stream into a standalone `GeneratePrimitive` without pushing it
   * onto the parent builder. The extracted primitive has a placeholder generator
   * that throws — call `.use(primitive)` on a builder to attach the real handler.
   *
   * Use this to declare the stream contract in a shared file and attach the
   * generator in a concrete handler file.
   */
  extract(): GeneratePrimitive {
    const streamPrimitive = createStream<TEvent, TPayload, TChunks, typeof this._nudges>(
      createStart(this._event, this._triggerSchema as (value: unknown) => TPayload, {
        broadcast: this._broadcast,
      }),
      ...this._nudges,
    );
    return createGenerate(streamPrimitive, () => {
      throw new Error(
        '[wskit] Stream extracted without .generate() — attach a generator before using.',
      );
    }) as GeneratePrimitive;
  }
}

/**
 * Module augmentation: adds `.stream()` to the builder interfaces so TypeScript
 * recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Open a stream sub-builder. Declare nudges with `.nudge()`, then attach
     * the generator with `.generate()`, and finish with `.done()`.
     *
     * @param eventContract  Describes the trigger event name and payload schema.
     * @param chunkSchema    Validator for each value the generator yields.
     * @param options.broadcast  When `true`, stream chunks go to all connections.
     */
    stream<TEvent extends string, TPayload, TChunks>(
      eventContract: EventContract<TEvent, TPayload>,
      chunkSchema: Validator<TChunks>,
      options?: { broadcast?: boolean },
    ): StreamBuilder<ServerBuilder<TState>, TState, TEvent, TPayload, TChunks>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Open a stream sub-builder. Declare nudges with `.nudge()`, then attach
     * the generator with `.generate()`, and finish with `.done()`.
     *
     * @param eventContract  Describes the trigger event name and payload schema.
     * @param chunkSchema    Validator for each value the generator yields.
     * @param options.broadcast  When `true`, stream chunks go to all connections.
     */
    stream<TEvent extends string, TPayload, TChunks>(
      eventContract: EventContract<TEvent, TPayload>,
      chunkSchema: Validator<TChunks>,
      options?: { broadcast?: boolean },
    ): StreamBuilder<GroupBuilder<TState>, TState, TEvent, TPayload, TChunks>;
  }
}

/**
 * Runtime implementation of `.stream()` for `ServerBuilder`.
 * Uses `(prototype as any)` because TypeScript cannot express a generic
 * method on a prototype assignment without `any`.
 */
(ServerBuilder.prototype as any).stream = function (
  this: ServerBuilder<any>,
  eventContract: EventContract,
  chunkSchema: Validator,
  options?: { broadcast?: boolean },
) {
  return new StreamBuilder(this, this._primitives, eventContract, chunkSchema, options);
};

/** Runtime implementation of `.stream()` for `GroupBuilder`. */
(GroupBuilder.prototype as any).stream = function (
  this: GroupBuilder<any>,
  eventContract: EventContract,
  chunkSchema: Validator,
  options?: { broadcast?: boolean },
) {
  return new StreamBuilder(this, this._primitives, eventContract, chunkSchema, options);
};
