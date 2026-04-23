/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { ScopeKind, ScopeStateShape } from '~/_types/scope-state/fold.ts';
import type {
  AckMethods,
  BufferedAmountMethods,
  ChannelScopeMethods,
  ChannelsMethods,
  ConnectionIdentityMethods,
  ConnectionMetaMethods,
  ConnectionTagsMethods,
  EnvMethods,
  GenericSendToMethods,
  LatencyMethods,
  NamespaceScopeMethods,
  QualityMethods,
  ReplayMethods,
  ReplayWire,
  RuntimeContextMethods,
  ScheduleMethods,
  SendMethods,
  SendToMethods,
  TagMethods,
  UntagMethods,
} from '~/_types/scope-state/methods.ts';
import type { NudgeDeclaration, StreamNudgesApi } from '~/stream/stream.ts';

// ---------------------------------------------------------------------------
// Conditional API helpers — only expose methods when they are meaningful
// ---------------------------------------------------------------------------

/**
 * Include typed `send` / `broadcast` only when the scope has declared at
 * least one outgoing event. An empty scope would only offer useless overloads.
 */
type SendApi<TOutgoing extends Record<string, any>> = keyof TOutgoing extends never
  ? {}
  : SendMethods<TOutgoing>;

/**
 * Use typed `sendTo` when outgoing events are known; fall back to the
 * untyped generic form so the method still exists in empty scopes.
 */
type SendToApi<TOutgoing extends Record<string, any>> = keyof TOutgoing extends never
  ? GenericSendToMethods
  : SendToMethods<TOutgoing>;

/**
 * Include `ctx.ack()` only in top-level scopes that registered `ack()`.
 *
 * `ack()` is not available inside namespace or channel scopes — those use
 * their own message flow.
 */
type AckApi<TState extends ScopeStateShape> = TState['kind'] extends 'top'
  ? TState['hasAck'] extends true
    ? AckMethods
    : {}
  : {};

/**
 * Include `ctx.sendReplay(...)` only when replay is enabled in this scope.
 *
 * If replay is enabled but no outgoing events are declared yet, the method
 * falls back to a broad `(event: string, payload: unknown)` signature so it
 * is still callable.
 */
type ReplayApi<TState extends ScopeStateShape> = TState['hasReplay'] extends true
  ? keyof TState['outgoing'] extends never
    ? {
        sendReplay(event: string, payload: unknown, wire: ReplayWire): void;
      }
    : ReplayMethods<TState['outgoing']>
  : {};

/**
 * Add the scope-specific fields (`ctx.namespace` or `ctx.channel`) based on
 * which kind of scope the handler lives in. Top-level handlers get neither.
 *
 * `TOutgoing` is threaded through so that `ctx.namespace.send()` and
 * `ctx.channel.broadcast()` are typed to the scope's declared events.
 */
type ScopeExtras<
  TKind extends ScopeKind,
  TOutgoing extends Record<string, any> = Record<string, any>,
  THasReplay extends boolean = false,
> = TKind extends 'namespace'
  ? NamespaceScopeMethods<TOutgoing>
  : TKind extends 'channel'
    ? ChannelScopeMethods<TOutgoing, THasReplay>
    : {};

// ---------------------------------------------------------------------------
// HandlerCtxFromState
// ---------------------------------------------------------------------------

/**
 * Build the typed handler ctx from a fully folded scope state.
 *
 * This is the type you see as `ctx` inside `incoming()`, `request()`, and
 * most intercept callbacks. It is an intersection of small interface slices,
 * each of which is conditionally included based on what the scope state says.
 *
 * How to read this type:
 *
 * | Slice | When present |
 * |-------------------------|------------------------------------------------------------|
 * | `SendApi` | Only when the scope has at least one `outgoing()` event |
 * | `SendToApi` | Always (typed when outgoing events exist, generic otherwise)|
 * | `ConnectionIdentity...` | Always — `ctx.id` |
 * | `ConnectionMeta...`     | Always — `ctx.meta` |
 * | `BufferedAmount...`     | Always — `ctx.bufferedAmount` |
 * | `Latency...`            | Always — `ctx.latency` |
 * | `Quality...`            | Always — `ctx.quality` |
 * | `ConnectionTags...`     | Always — `ctx.tags` |
 * | `TagMethods` | Always — `ctx.tag(label)` |
 * | `UntagMethods` | Always — `ctx.untag(label)` |
 * | `AckApi` | Only in top-level scope when `ack()` is registered |
 * | `ReplayApi` | Only when `replay()` is registered |
 * | `ChannelsMethods` | Always — `ctx.channels` |
 * | `ScopeExtras` | `ctx.namespace.name` or `ctx.channel.name` based on kind |
 */
export type HandlerCtxFromState<TState extends ScopeStateShape> = SendApi<TState['outgoing']> &
  SendToApi<TState['outgoing']> &
  ConnectionIdentityMethods &
  ConnectionMetaMethods<TState['meta']> &
  BufferedAmountMethods &
  LatencyMethods &
  QualityMethods &
  ConnectionTagsMethods &
  TagMethods &
  UntagMethods &
  AckApi<TState> &
  ReplayApi<TState> &
  ScheduleMethods<TState['scheduledTaskIds'] extends never ? string : TState['scheduledTaskIds']> &
  ChannelsMethods<TState['channelNames'] extends never ? string : TState['channelNames']> &
  RuntimeContextMethods &
  EnvMethods<TState['env']> &
  ScopeExtras<TState['kind'], TState['outgoing'], TState['hasReplay']>;

// ---------------------------------------------------------------------------
// StreamBaseCtxFromState / StreamCtxFromState
// ---------------------------------------------------------------------------

/**
 * Build the base ctx for stream generator functions.
 *
 * This is identical to `HandlerCtxFromState` except that `ctx.ack()` is
 * intentionally omitted. Stream generators run over a longer period of
 * time and are not expected to acknowledge individual messages.
 */
export type StreamBaseCtxFromState<TState extends ScopeStateShape> = SendApi<TState['outgoing']> &
  SendToApi<TState['outgoing']> &
  ConnectionIdentityMethods &
  ConnectionMetaMethods<TState['meta']> &
  BufferedAmountMethods &
  LatencyMethods &
  QualityMethods &
  ConnectionTagsMethods &
  TagMethods &
  UntagMethods &
  ReplayApi<TState> &
  ChannelsMethods<TState['channelNames'] extends never ? string : TState['channelNames']> &
  RuntimeContextMethods &
  EnvMethods<TState['env']> &
  ScopeExtras<TState['kind'], TState['outgoing'], TState['hasReplay']>;

/**
 * Build the full ctx for a stream generator by adding `ctx.nudges(...)` on
 * top of the stream base ctx.
 *
 * `ctx.nudges(...)` lets the generator subscribe to client nudge messages
 * (e.g. `cancel`, `add-context`) that arrive while the stream is active.
 *
 * `TNudges` is the tuple of `nudge(...)` declarations from the stream definition.
 */
export type StreamCtxFromState<
  TState extends ScopeStateShape,
  TNudges extends readonly NudgeDeclaration[],
> = StreamBaseCtxFromState<TState> & StreamNudgesApi<TNudges>;
