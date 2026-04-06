/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/primitives/intercept.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';
import type {
  FoldablePrimitive,
  FoldState,
  HandlerCtxFromState,
  ScopeKind,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/types/scope-state.ts';

/**
 * Append one primitive to the end of a prefix tuple.
 *
 * This is mostly used when a later callback should see the effects of a
 * primitive that sits immediately before it, like a pre-intercept.
 */
export type AppendFoldable<
  TItems extends readonly FoldablePrimitive[],
  TItem extends FoldablePrimitive,
> = readonly [...TItems, TItem];

/**
 * Fold one prefix tuple inside one specific scope.
 *
 * This is the internal "given these earlier primitives, what state do we
 * have now?" helper that all exported bridge aliases build on.
 */
type PrefixState<TKind extends ScopeKind, TPrefix extends readonly FoldablePrimitive[]> = FoldState<
  TPrefix,
  ScopeState<TKind>
>;

/**
 * The normal handler ctx produced by a prefix in a given scope.
 *
 * Example: if the prefix contains `ack()` and `outgoing('message', ...)`,
 * the result includes `ctx.ack()`, `ctx.send('message', ...)`, and
 * `ctx.broadcast('message', ...)`.
 */
export type HandlerCtxForPrefix<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
> = HandlerCtxFromState<PrefixState<TKind, TPrefix>>;

/**
 * The base stream ctx produced by a prefix in a given scope.
 *
 * This is the non-stream-local part of generator ctx. Stream-local
 * `ctx.nudges(...)` is added later by `generate(...)`.
 */
export type StreamBaseCtxForPrefix<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
> = StreamBaseCtxFromState<PrefixState<TKind, TPrefix>>;

/**
 * Rebuild an `incoming()` primitive so its callback sees the folded ctx
 * from everything that came before it.
 */
export type IncomingForPrefix<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
  TEvent extends string,
  TPayload,
> = IncomingPrimitive<TEvent, TPayload, HandlerCtxForPrefix<TKind, TPrefix>>;

/**
 * Rebuild a `request()` primitive so its callback sees the folded ctx
 * from everything that came before it.
 */
export type RequestForPrefix<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
  TEvent extends string,
  TPayload,
  TResponse,
> = RequestPrimitive<TEvent, TPayload, TResponse, HandlerCtxForPrefix<TKind, TPrefix>>;

/**
 * Rebuild a `generate()` primitive so its generator sees the folded base
 * stream ctx from everything that came before it.
 */
export type GenerateForPrefix<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
> = GeneratePrimitive<TStream, StreamBaseCtxForPrefix<TKind, TPrefix>, any>;

/**
 * Rebuild a pre-intercept primitive so its callback sees the folded ctx
 * from everything that came before it.
 */
export type PreInterceptForPrefix<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
> = PreInterceptPrimitive<HandlerCtxForPrefix<TKind, TPrefix>>;

/**
 * Rebuild a post-intercept primitive so its callback sees the ctx after
 * the matching `incoming()` has been added to the prefix.
 *
 * That is why this helper takes the `incoming()` primitive itself instead
 * of just the event and payload types.
 */
export type PostInterceptForIncoming<
  TKind extends ScopeKind,
  TPrefix extends readonly FoldablePrimitive[],
  TIncoming extends IncomingPrimitive<string, any, any>,
> =
  TIncoming extends IncomingPrimitive<infer TEvent, infer TPayload, any>
    ? PostInterceptPrimitive<
        TEvent,
        TPayload,
        HandlerCtxForPrefix<TKind, AppendFoldable<TPrefix, TIncoming>>
      >
    : never;
