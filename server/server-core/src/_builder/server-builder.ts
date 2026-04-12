/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EventContract } from '~/event.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type {
  FoldablePrimitive,
  HandlerCtxFromState,
  NextState,
  NoOutgoing,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
import { incoming as createIncoming } from '~/incoming/incoming.ts';
import { outgoing as createOutgoing } from '~/outgoing/outgoing.ts';
import { validateBuild } from './validate.ts';

type InitialState = ScopeState<'top', NoOutgoing, false, false>;

type StateAfterOutgoing<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, OutgoingPrimitive<TEvent, TPayload>>;

type StateAfterIncoming<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
> = NextState<TState, IncomingPrimitive<TEvent, TPayload, any>>;

export class ServerBuilder<TState extends ScopeStateShape = InitialState> {
  /** @internal */
  readonly _primitives: Primitive[] = [];
  /** @internal */
  readonly _name: string;

  constructor(name: string) {
    this._name = name;
  }

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): ServerBuilder<StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): ServerBuilder<StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  use<P extends Primitive>(primitive: P): ServerBuilder<NextState<TState, P & FoldablePrimitive>> {
    if (primitive.__wskit === 'group') {
      this._primitives.push(...(primitive as unknown as GroupPrimitive).primitives);
    } else {
      this._primitives.push(primitive);
    }
    return this as any;
  }

  group(): GroupBuilder<TState> {
    return new GroupBuilder<TState>(this);
  }

  done(): ServerDefinition<readonly Primitive[]> {
    validateBuild(this._primitives);
    return Object.freeze({
      __wskit: 'server' as const,
      primitives: Object.freeze([...this._primitives]) as readonly Primitive[],
    });
  }
}

export class GroupBuilder<TState extends ScopeStateShape> {
  /** @internal */
  readonly _primitives: Primitive[] = [];
  /** @internal */
  readonly _parent: ServerBuilder<TState>;

  constructor(parent: ServerBuilder<TState>) {
    this._parent = parent;
  }

  outgoing<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
  ): GroupBuilder<StateAfterOutgoing<TState, TEvent, TPayload>> {
    this._primitives.push(createOutgoing<TEvent, TPayload>(eventContract.event));
    return this as any;
  }

  incoming<TEvent extends string, TPayload>(
    eventContract: EventContract<TEvent, TPayload>,
    handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => void | Promise<void>,
  ): GroupBuilder<StateAfterIncoming<TState, TEvent, TPayload>> {
    this._primitives.push(
      createIncoming(eventContract.event, handler as any, { validator: eventContract.schema }),
    );
    return this as any;
  }

  use<P extends Primitive>(primitive: P): GroupBuilder<NextState<TState, P & FoldablePrimitive>> {
    this._primitives.push(primitive);
    return this as any;
  }

  extract(): GroupPrimitive<TState> {
    return {
      __wskit: 'group' as const,
      __kind: 'scope' as const,
      __identity: [Symbol('group')] as const,
      __dependencies: [],
      __requires: {},
      primitives: [...this._primitives],
    } as GroupPrimitive<TState>;
  }

  done(): ServerBuilder<TState> {
    this._parent._primitives.push(...this._primitives);
    return this._parent as any;
  }
}

export interface GroupPrimitive<_TState extends ScopeStateShape = ScopeStateShape>
  extends Primitive<'group'> {
  readonly primitives: readonly Primitive[];
}

export function server(name: string): ServerBuilder {
  return new ServerBuilder(name);
}
