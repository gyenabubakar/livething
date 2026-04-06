/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { AckPrimitive } from '~/primitives/ack.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type NoOutgoing = Record<never, never>;

type OutgoingPayload<TOutgoing extends AnyOutgoing> =
  TOutgoing extends OutgoingPrimitive<string, infer TPayload> ? TPayload : never;

type OutgoingMap<TOutgoing extends readonly AnyOutgoing[]> = {
  [TItem in TOutgoing[number] as TItem['event']]: OutgoingPayload<TItem>;
};

interface SendMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send an event to the current connection.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  send<TEvent extends keyof TOutgoing & string>(event: TEvent, payload: TOutgoing[TEvent]): void;

  /**
   * Broadcast an event to other connections in the current scope.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  broadcast<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
  ): void;
}

type SendApi<TOutgoing extends Record<string, any>> = keyof TOutgoing extends never
  ? {}
  : SendMethods<TOutgoing>;

interface AckMethods {
  /**
   * Confirm receipt of the current incoming message.
   *
   * This only exists when `ack()` is registered in the same scope.
   */
  ack(): void;
}

type AckApi<THasAck extends boolean> = THasAck extends true ? AckMethods : {};

export type ServerHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
> = SendApi<TOutgoing> & AckApi<THasAck>;

export type StreamServerHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  SendApi<TOutgoing>;

export interface ServerDefinition<TPrimitives extends readonly Primitive[] = readonly Primitive[]> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
}

/**
 * Define a WebSocket server using a flat list of primitives.
 *
 * Typing rule: primitives that affect handler ctx must come before the
 * handlers they type in the same scope.
 */
export function defineServer<O1 extends AnyOutgoing>(
  o1: O1,
  incomingPrimitive: IncomingPrimitive<string, any, ServerHandlerContext<OutgoingMap<[O1]>, false>>,
): ServerDefinition<readonly [O1, typeof incomingPrimitive]>;
export function defineServer<O1 extends AnyOutgoing>(
  ackPrimitive: AckPrimitive,
  o1: O1,
  incomingPrimitive: IncomingPrimitive<string, any, ServerHandlerContext<OutgoingMap<[O1]>, true>>,
): ServerDefinition<readonly [AckPrimitive, O1, typeof incomingPrimitive]>;
export function defineServer<
  O1 extends AnyOutgoing,
  O2 extends AnyOutgoing,
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
>(
  ackPrimitive: AckPrimitive,
  o1: O1,
  o2: O2,
  incomingPrimitive: IncomingPrimitive<
    string,
    any,
    ServerHandlerContext<OutgoingMap<[O1, O2]>, true>
  >,
  requestPrimitive: RequestPrimitive<
    string,
    any,
    any,
    ServerHandlerContext<OutgoingMap<[O1, O2]>, true>
  >,
  generatePrimitive: GeneratePrimitive<
    TStream,
    StreamServerHandlerContext<OutgoingMap<[O1, O2]>>,
    any
  >,
): ServerDefinition<
  readonly [
    AckPrimitive,
    O1,
    O2,
    typeof incomingPrimitive,
    typeof requestPrimitive,
    typeof generatePrimitive,
  ]
>;
export function defineServer(
  ...primitives: readonly Primitive[]
): ServerDefinition<readonly Primitive[]> {
  return Object.freeze({
    __wskit: 'server' as const,
    primitives: Object.freeze([...primitives]) as readonly Primitive[],
  });
}
