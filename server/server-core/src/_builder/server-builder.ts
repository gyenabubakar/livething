/* oxlint-disable @typescript-eslint/no-explicit-any */
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import type {
  FeatureApplicator,
  GroupBuilderFull,
  ServerBuilderFull,
} from '~/_types/feature-methods.ts';
import type {
  ClientContractState,
  FoldablePrimitive,
  HandlerCtxFromState,
  MergeRecords,
  NextState,
  NoOutgoing,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import type { ChannelPrimitive } from '~/channel/channel.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { NamespacePrimitive } from '~/namespace/namespace.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { validateBuild } from './validate.ts';

type ContractFromState<TState extends ScopeStateShape> = {
  readonly incoming: TState['contract']['incoming'];
  readonly outgoing: TState['contract']['outgoing'];
  readonly requests: TState['contract']['requests'];
  readonly streams: TState['contract']['streams'];
  readonly errors: ErrorMapFromDefs<TState['errors']>;
  readonly channels: TState['contract']['channels'];
  readonly namespaces: TState['contract']['namespaces'];
};

type ErrorMapFromDefs<TDefs extends readonly ErrorDef<string, any>[]> = {
  [TDef in TDefs[number] as TDef extends ErrorDef<infer TCode, any>
    ? TCode
    : never]: TDef extends ErrorDef<string, infer TDetail> ? TDetail : never;
};

/** The blank-slate state every new `ServerBuilder` starts from. */
type InitialState<TEnv extends object = Record<string, unknown>> = ScopeState<
  'top',
  NoOutgoing,
  false,
  false,
  { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
  readonly [],
  Record<string, unknown>,
  never,
  never,
  TEnv
>;

type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

type MergeScopeContract<
  TState extends ScopeStateShape,
  TField extends 'channels' | 'namespaces',
  TName extends string,
  TContract,
> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: {
    incoming: TState['contract']['incoming'];
    outgoing: TState['contract']['outgoing'];
    requests: TState['contract']['requests'];
    streams: TState['contract']['streams'];
    channels: TField extends 'channels'
      ? MergeRecords<TState['contract']['channels'], Record<TName, TContract>>
      : TState['contract']['channels'];
    namespaces: TField extends 'namespaces'
      ? MergeRecords<TState['contract']['namespaces'], Record<TName, TContract>>
      : TState['contract']['namespaces'];
  };
  readonly errors: TState['errors'];
  readonly meta: TState['meta'];
  readonly channelNames: TField extends 'channels'
    ? TState['channelNames'] | TName
    : TState['channelNames'];
  readonly scheduledTaskIds: TState['scheduledTaskIds'];
  readonly env: TState['env'];
};

type MergeGroupContract<
  TState extends ScopeStateShape,
  TGroupContract extends ClientContractState,
> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: {
    incoming: MergeRecords<TState['contract']['incoming'], TGroupContract['incoming']>;
    outgoing: MergeRecords<TState['contract']['outgoing'], TGroupContract['outgoing']>;
    requests: MergeRecords<TState['contract']['requests'], TGroupContract['requests']>;
    streams: MergeRecords<TState['contract']['streams'], TGroupContract['streams']>;
    channels: MergeRecords<TState['contract']['channels'], TGroupContract['channels']>;
    namespaces: MergeRecords<TState['contract']['namespaces'], TGroupContract['namespaces']>;
  };
  readonly errors: TState['errors'];
  readonly meta: TState['meta'];
  readonly channelNames: TState['channelNames'];
  readonly scheduledTaskIds: TState['scheduledTaskIds'];
  readonly env: TState['env'];
};

type UseResult<TState extends ScopeStateShape, P extends Primitive> =
  P extends GroupPrimitive<infer TGroupState extends ScopeStateShape>
    ? MergeGroupContract<TState, TGroupState['contract']>
    : P extends ChannelPrimitive<any, any, infer TName extends string, infer TContract>
      ? MergeScopeContract<TState, 'channels', TName, TContract>
      : P extends NamespacePrimitive<any, any, infer TName extends string, infer TContract>
        ? MergeScopeContract<TState, 'namespaces', TName, TContract>
        : P extends FoldablePrimitive
          ? NextState<TState, P>
          : TState;

type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

/**
 * The fluent builder used to define a wskit WebSocket server.
 *
 * `TState` tracks accumulated primitives; `TFeatures` tracks which `with*`
 * wrappers have been applied. Feature methods (`.ack()`, `.onConnect()`, etc.)
 * are not on this class — they are added at runtime by `with*` functions and
 * surfaced at the type level via the `ServerBuilderFull` intersection type.
 *
 * @template TState - Accumulated builder state.
 * @template TFeatures - Feature flags set by `with*` wrappers.
 */
export class ServerBuilder<TState extends ScopeStateShape = InitialState, TFeatures = {}> {
  readonly _primitives: Primitive[] = [];
  readonly _name: string;
  readonly _featureApplicators: FeatureApplicator[] = [];

  constructor(name: string) {
    this._name = name;
  }

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ServerBuilderFull<StateAfterOutgoing<TState, TEvent, TPayload>, TFeatures> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ServerBuilderFull<StateAfterIncoming<TState, TEvent, TPayload>, TFeatures> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  use<P extends Primitive>(primitive: P): ServerBuilderFull<UseResult<TState, P>, TFeatures> {
    if (primitive.__wskit === 'group') {
      this._primitives.push(...(primitive as unknown as GroupPrimitive).primitives);
    } else {
      this._primitives.push(primitive);
    }
    return this as any;
  }

  group<TGroupState extends ScopeStateShape>(
    callback: (
      builder: GroupBuilderFull<TState, TFeatures>,
    ) => GroupBuilderFull<TGroupState, TFeatures>,
  ): GroupPrimitive<TGroupState> {
    const builder = new GroupBuilder<TState, TFeatures>(this);
    for (const applicator of this._featureApplicators) {
      applicator(builder, 'group');
    }
    callback(builder as any);
    return {
      __wskit: 'group' as const,
      __kind: 'scope' as const,
      __identity: [Symbol('group')] as const,
      __dependencies: [],
      __requires: {},
      primitives: [...builder._primitives],
    } as GroupPrimitive<TGroupState>;
  }

  build(): ServerDefinition<readonly Primitive[], ContractFromState<TState>> {
    validateBuild(this._primitives);
    return Object.freeze({
      __wskit: 'server' as const,
      primitives: Object.freeze([...this._primitives]) as readonly Primitive[],
    });
  }
}

/**
 * A sub-builder for collecting a reusable set of flat primitives.
 *
 * @template TState - Inherited from the parent `ServerBuilder`.
 * @template TFeatures - Feature flags inherited from the parent.
 */
export class GroupBuilder<TState extends ScopeStateShape, TFeatures = {}> {
  readonly _primitives: Primitive[] = [];
  readonly _featureApplicators: FeatureApplicator[] = [];
  readonly _parent: ServerBuilder<TState, TFeatures>;

  constructor(parent: ServerBuilder<TState, TFeatures>) {
    this._parent = parent;
  }

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): GroupBuilderFull<StateAfterOutgoing<TState, TEvent, TPayload>, TFeatures> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): GroupBuilderFull<StateAfterIncoming<TState, TEvent, TPayload>, TFeatures> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  use<P extends Primitive>(
    primitive: P extends { __wskit: 'group' } ? never : P,
  ): GroupBuilderFull<UseResult<TState, P>, TFeatures> {
    this._primitives.push(primitive);
    return this as any;
  }
}

export interface GroupPrimitive<
  _TState extends ScopeStateShape = ScopeStateShape,
> extends Primitive<'group'> {
  readonly primitives: readonly Primitive[];
}

export function server<TEnv extends object = Record<string, unknown>>(
  name: string,
): ServerBuilderFull<InitialState<TEnv>, {}> {
  return new ServerBuilder(name) as ServerBuilderFull<InitialState<TEnv>, {}>;
}
