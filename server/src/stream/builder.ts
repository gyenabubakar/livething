import {
  generate as createGenerate,
  nudge as createNudge,
  start as createStart,
  stream as createStream,
} from '~/stream/stream.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state';
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  NudgeDeclaration,
  StreamHandlerContext,
  StreamNudgeMessages,
} from '~/stream/stream.ts';
import type { Validator } from '~/types.ts';

/**
 * Fluent builder for defining a streaming endpoint. Streams let the server
 * push a sequence of chunks (via an async generator) to the client, with
 * optional nudges (mid-stream signals from the client) and broadcast mode.
 */
export class StreamBuilder<
  TParentBuilder,
  TParentState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[] = readonly [],
> {
  /** @internal Reference to the parent builder for `_seal()`. */
  readonly _parentBuilder: TParentBuilder;
  /** @internal The parent builder's primitive array for `.generate()` to push into. */
  readonly _parentPrimitives: Primitive[];
  /** @internal The trigger event name. */
  readonly _event: TEvent;
  /** @internal Validator for the trigger payload. */
  readonly _triggerSchema: Validator<TPayload>;
  /** @internal Whether to fan the stream out to all connections. */
  _broadcast = false;
  /** @internal Nudge declarations accumulated via `.nudge()`. */
  readonly _nudges: NudgeDeclaration[] = [];

  constructor(
    parentBuilder: TParentBuilder,
    parentPrimitives: Primitive[],
    eventContract: EventContract<TEvent, TPayload>,
    _chunkSchema: Validator<TChunks>,
  ) {
    this._parentBuilder = parentBuilder;
    this._parentPrimitives = parentPrimitives;
    this._event = eventContract.event;
    this._triggerSchema = eventContract.schema;
  }

  /**
   * Enable broadcast mode: each chunk yielded by the generator will be sent to
   * all active connections, not just the one that triggered the stream.
   */
  broadcast(): this {
    this._broadcast = true;
    return this;
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
    /* oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Validator union can't satisfy either overload individually */
    this._nudges.push(createNudge(eventContract.event, eventContract.schema as any));
    return this as unknown as StreamBuilder<
      TParentBuilder,
      TParentState,
      TEvent,
      TPayload,
      TChunks,
      readonly [...TNudges, NudgeDeclaration<NEvent, NPayload>]
    >;
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
    /* oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic boundary between builder and primitive factory */
    const generatePrimitive = createGenerate(streamPrimitive, handler as any);
    this._parentPrimitives.push(streamPrimitive as Primitive);
    this._parentPrimitives.push(generatePrimitive as Primitive);
    return this;
  }
}
