/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamHandlerContext,
  StreamNudgeMessages,
} from '~/stream/stream.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import {
  stream as createStream,
  start as createStart,
  nudge as createNudge,
  generate as createGenerate,
} from '~/stream/stream.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

export class StreamBuilder<
  TParentBuilder,
  TParentState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[] = readonly [],
> {
  /** @internal */
  readonly _parentBuilder: TParentBuilder;
  /** @internal */
  readonly _parentPrimitives: Primitive[];
  /** @internal */
  readonly _event: TEvent;
  /** @internal */
  readonly _triggerSchema: Validator<TPayload>;
  /** @internal */
  readonly _broadcast: boolean;
  /** @internal */
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

  nudge<NEvent extends string, NPayload = unknown>(
    eventContract: EventContract<NEvent, NPayload>,
  ): StreamBuilder<TParentBuilder, TParentState, TEvent, TPayload, TChunks, readonly [...TNudges, NudgeDeclaration<NEvent, NPayload>]> {
    this._nudges.push(createNudge(eventContract.event, eventContract.schema as any));
    return this as any;
  }

  generate(
    handler: (
      ctx: StreamHandlerContext<HandlerCtxFromState<TParentState>, TNudges>,
      payload: TPayload,
    ) => AsyncGenerator<TChunks, void, TNudges extends readonly [] ? undefined : StreamNudgeMessages<TNudges>>,
  ): StreamBuilder<TParentBuilder, TParentState, TEvent, TPayload, TChunks, TNudges> {
    const streamPrimitive = createStream<TEvent, TPayload, TChunks, typeof this._nudges>(
      createStart(this._event, this._triggerSchema as (value: unknown) => TPayload, { broadcast: this._broadcast }),
      ...this._nudges,
    );
    const generatePrimitive = createGenerate(streamPrimitive, handler as any);
    this._parentPrimitives.push(streamPrimitive as Primitive);
    this._parentPrimitives.push(generatePrimitive as Primitive);
    return this as any;
  }

  done(): TParentBuilder {
    return this._parentBuilder;
  }

  extract(): GeneratePrimitive {
    const streamPrimitive = createStream<TEvent, TPayload, TChunks, typeof this._nudges>(
      createStart(this._event, this._triggerSchema as (value: unknown) => TPayload, { broadcast: this._broadcast }),
      ...this._nudges,
    );
    return createGenerate(streamPrimitive, () => {
      throw new Error('[wskit] Stream extracted without .generate() — attach a generator before using.');
    }) as GeneratePrimitive;
  }
}

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    stream<TEvent extends string, TPayload, TChunks>(
      eventContract: EventContract<TEvent, TPayload>,
      chunkSchema: Validator<TChunks>,
      options?: { broadcast?: boolean },
    ): StreamBuilder<ServerBuilder<TState>, TState, TEvent, TPayload, TChunks>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    stream<TEvent extends string, TPayload, TChunks>(
      eventContract: EventContract<TEvent, TPayload>,
      chunkSchema: Validator<TChunks>,
      options?: { broadcast?: boolean },
    ): StreamBuilder<GroupBuilder<TState>, TState, TEvent, TPayload, TChunks>;
  }
}

(ServerBuilder.prototype as any).stream = function (this: ServerBuilder<any>, eventContract: EventContract, chunkSchema: Validator, options?: { broadcast?: boolean }) {
  return new StreamBuilder(this, this._primitives, eventContract, chunkSchema, options);
};

(GroupBuilder.prototype as any).stream = function (this: GroupBuilder<any>, eventContract: EventContract, chunkSchema: Validator, options?: { broadcast?: boolean }) {
  return new StreamBuilder(this, this._primitives, eventContract, chunkSchema, options);
};
