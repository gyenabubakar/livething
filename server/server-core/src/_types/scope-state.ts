/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { AckPrimitive } from '~/ack/ack.ts';
import type { ChannelManager, ConnectionContext } from '~/context.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { HibernationPrimitive } from '~/hibernation/hibernation.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { CustomReplayPrimitive } from '~/replay/custom/custom.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ScheduledPrimitive } from '~/scheduled/scheduled.ts';
import type { SequencePrimitive } from '~/sequence/sequence.ts';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamNudgesApi,
  StreamPrimitive,
} from '~/stream/stream.ts';

// ---------------------------------------------------------------------------
// Shorthand aliases — used throughout this file to keep lines manageable
// ---------------------------------------------------------------------------

type AnyErrorDef = ErrorDef<string, any>;
type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type AnyErrors = ErrorsPrimitive<readonly AnyErrorDef[]>;
type AnyReplay = ReplayPrimitive;
type AnyCustomReplay = CustomReplayPrimitive;
type AnyIntercept = InterceptPrimitive<string, any, any>;

// ---------------------------------------------------------------------------
// The fold engine — how typed ctx is built from a list of primitives
// ---------------------------------------------------------------------------
//
// The builder's fluent API produces a tuple of primitives:
//
//   server('chat').ack().outgoing('typing', ...).incoming('message', ...)
//
// Internally this becomes something like:
//
//   readonly [AckPrimitive, OutgoingPrimitive<'typing', ...>, IncomingPrimitive<'message', ...>]
//
// To derive the correctly typed ctx for each handler, we "fold" that tuple
// from left to right. Each primitive advances the state by one step:
//
//   ScopeState (empty)
//     → NextState<state, AckPrimitive>          hasAck: true
//     → NextState<state, OutgoingPrimitive>      outgoing: { typing: ... }
//     → NextState<state, IncomingPrimitive>      contract.outgoing: { message: ... }
//
// The final state is then fed into `HandlerCtxFromState` to produce the ctx
// type that the developer sees in their handler callbacks.
//
// This is entirely a compile-time operation — no runtime cost.

// ---------------------------------------------------------------------------
// FoldablePrimitive
// ---------------------------------------------------------------------------

/**
 * Every primitive shape that the fold engine knows how to process.
 *
 * When the builder collects primitives, each one is tested against this union.
 * Primitives that match are folded into the accumulated state; others are
 * ignored by the fold but still collected for the runtime.
 *
 * `namespace()` and `channel()` are excluded here because they create their
 * own nested folds — each scope runs its own independent fold over its own
 * list of child primitives.
 */
export type FoldablePrimitive =
  | AckPrimitive
  | HeartbeatPrimitive
  | HibernationPrimitive
  | SequencePrimitive
  | DedupPrimitive
  | AnyReplay
  | AnyCustomReplay
  | ScheduledPrimitive<string, any, any>
  | AnyIntercept
  | AnyErrors
  | AnyOutgoing
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

// ---------------------------------------------------------------------------
// ScopeKind
// ---------------------------------------------------------------------------

/**
 * Which level of scope is currently being typed.
 *
 * The scope kind controls which extra fields appear on ctx:
 * - `'top'`       — the root server scope (no namespace/channel extras)
 * - `'namespace'` — inside a `.namespace()` block (`ctx.namespace.name`)
 * - `'channel'`   — inside a `.channel()` block (`ctx.channel.name`)
 */
export type ScopeKind = 'top' | 'namespace' | 'channel';

// ---------------------------------------------------------------------------
// ClientContractState
// ---------------------------------------------------------------------------

/**
 * The client-facing contract accumulated while folding primitives.
 *
 * Each handler primitive (`incoming`, `request`, `generate`) adds entries
 * to this as the fold processes the primitive tuple. The final value of
 * `contract` in the folded state becomes the data that `InferClient` reads
 * to produce the client SDK types.
 *
 * - `incoming`  — events the server receives from clients (added by `incoming()`)
 * - `outgoing`  — events the server sends to clients   (added by `outgoing()`)
 * - `requests`  — request/response pairs               (added by `request()`)
 * - `streams`   — streaming generators                 (added by `generate()`)
 */
export interface ClientContractState {
  readonly incoming: Record<string, any>;
  readonly outgoing: Record<string, any>;
  readonly requests: Record<string, any>;
  readonly streams: Record<string, any>;
  readonly channels: Record<string, any>;
  readonly namespaces: Record<string, any>;
}

// ---------------------------------------------------------------------------
// ScopeStateShape
// ---------------------------------------------------------------------------

/**
 * The minimal shape every scope state must satisfy.
 *
 * Most helper types in this file only need these fields — not the exact
 * generic parameters of `ScopeState`. Accepting `ScopeStateShape` instead
 * of `ScopeState<...>` keeps constraint types simpler and more readable.
 */
export interface ScopeStateShape {
  readonly kind: ScopeKind;
  readonly outgoing: Record<string, any>;
  readonly hasAck: boolean;
  readonly hasReplay: boolean;
  readonly contract: ClientContractState;
  readonly errors: readonly AnyErrorDef[];
  readonly meta: Record<string, unknown>;
  readonly channelNames: string;
  readonly scheduledTaskIds: string;
}

// ---------------------------------------------------------------------------
// NoOutgoing
// ---------------------------------------------------------------------------

/**
 * Placeholder for "no outgoing events registered yet" in a fresh scope.
 *
 * Using `Record<never, never>` (an empty object with no possible keys) keeps
 * the type precise. Using `Record<string, unknown>` would accidentally allow
 * any string as a valid event name, breaking type-checking on `ctx.send(...)`.
 */
export type NoOutgoing = Record<never, never>;

// ---------------------------------------------------------------------------
// ScopeState
// ---------------------------------------------------------------------------

/**
 * The full accumulated state for one scope as primitives are registered.
 *
 * Start at the default (all-false, empty) state and advance it by passing
 * it through `NextState` for each primitive in the tuple.
 *
 * Fields:
 * - `kind`         — which scope we are in (`'top'`, `'namespace'`, `'channel'`)
 * - `outgoing`     — the outgoing event map that handler `send()` / `broadcast()` are typed against
 * - `hasAck`       — `true` once `ack()` has been seen; unlocks `ctx.ack()` for handlers
 * - `hasReplay`    — `true` once `replay()` has been seen; unlocks `ctx.sendReplay(...)` for handlers
 * - `contract`     — the client-facing contract built up so far
 * - `errors`       — the list of server error definitions registered with `errors()`
 * - `meta`         — the per-connection metadata shape inferred from `.onUpgrade()` return
 * - `channelNames`      — union of registered channel names for typed `ctx.channels` methods
 * - `scheduledTaskIds`  — union of registered scheduled task IDs for typed `ctx.schedule()`
 *
 * All parameters have default values so `ScopeState` (no arguments) gives a
 * clean empty starting state for the top-level scope.
 */
export type ScopeState<
  TKind extends ScopeKind = 'top',
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
  THasReplay extends boolean = false,
  TContract extends ClientContractState = {
    incoming: {};
    outgoing: {};
    requests: {};
    streams: {};
    channels: {};
    namespaces: {};
  },
  TErrors extends readonly AnyErrorDef[] = readonly [],
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TChannelNames extends string = never,
  TScheduledTaskIds extends string = never,
> = {
  readonly kind: TKind;
  readonly outgoing: TOutgoing;
  readonly hasAck: THasAck;
  readonly hasReplay: THasReplay;
  readonly contract: TContract;
  readonly errors: TErrors;
  readonly meta: TMeta;
  readonly channelNames: TChannelNames;
  readonly scheduledTaskIds: TScheduledTaskIds;
};

// ---------------------------------------------------------------------------
// MergeRecords
// ---------------------------------------------------------------------------

/**
 * Merge two record types into one, with keys from `B` overriding keys from `A`.
 *
 * This is the core "append a new event to the existing map" helper. Every
 * time the fold encounters a primitive that declares new events or handlers,
 * it uses `MergeRecords` to add them to the accumulated state without losing
 * whatever was already there.
 *
 * ```ts
 * type Before = { chat: string };
 * type New    = { typing: boolean };
 * type After  = MergeRecords<Before, New>; // { chat: string; typing: boolean }
 * ```
 */
export type MergeRecords<A, B> = {
  [TKey in keyof A | keyof B]: TKey extends keyof B
    ? B[TKey]
    : TKey extends keyof A
      ? A[TKey]
      : never;
};

// ---------------------------------------------------------------------------
// Entry helpers — convert one primitive into its contract contribution
// ---------------------------------------------------------------------------

/**
 * Extract `{ eventName: payloadType }` from an `outgoing()` primitive.
 *
 * Used by `NextState` to add the new outgoing event to both `state.outgoing`
 * (for typed `send` / `broadcast`) and `state.contract.incoming` (for the
 * client contract — what the client *receives* is what the server *sends*).
 */
type OutgoingEntry<TPrimitive extends AnyOutgoing> =
  TPrimitive extends OutgoingPrimitive<infer TEvent, infer TPayload>
    ? Record<TEvent, TPayload>
    : never;

/**
 * Extract `{ eventName: { payload, response } }` from a `request()` primitive.
 *
 * This becomes the `requests` field in the client contract.
 */
type RequestEntry<TPrimitive extends AnyRequest> =
  TPrimitive extends RequestPrimitive<infer TEvent, infer TPayload, infer TResponse, any>
    ? Record<TEvent, { payload: TPayload; response: TResponse }>
    : never;

/**
 * Convert a stream's nudge declarations into a simple `{ eventName: payloadType }` map.
 *
 * Nudges are client-to-server messages that influence an active stream (for
 * example, cancelling it or providing additional context mid-stream).
 *
 * Example — given:
 * ```ts
 * readonly [nudge('cancel'), nudge('add-context', v.object({ hint: v.string() }))]
 * ```
 * This produces:
 * ```ts
 * { cancel: unknown; 'add-context': { hint: string } }
 * ```
 */
type NudgeMap<TNudges extends readonly NudgeDeclaration[]> = {
  [TNudge in TNudges[number] as TNudge['event']]: TNudge extends NudgeDeclaration<
    string,
    infer TPayload
  >
    ? TPayload
    : never;
};

/**
 * Convert a `StreamPrimitive` into its client-facing contract entry.
 *
 * Produces `{ eventName: { payload, chunks, nudges? } }`.
 * The `nudges` field is only included when the stream declares at least
 * one nudge — `keyof NudgeMap<TNudges> extends never` detects an empty map.
 */
type StreamEntry<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, infer TPayload, infer TChunks, infer TNudges>
    ? Record<
        TStream['event'],
        {
          payload: TPayload;
          chunk: TChunks;
        } & (keyof NudgeMap<TNudges> extends never ? {} : { nudges: NudgeMap<TNudges> })
      >
    : never;

// ---------------------------------------------------------------------------
// NextState
// ---------------------------------------------------------------------------

/**
 * Apply one primitive to the current scope state and return the next state.
 *
 * This is the heart of the fold engine. Each branch says exactly what one
 * primitive changes:
 *
 * | Primitive                           | What changes                                              |
 * |-------------------------------------|-----------------------------------------------------------|
 * | `ack()`                             | `hasAck` flips to `true` → unlocks `ctx.ack()`            |
 * | `heartbeat()`, `hibernation()`, etc.| Nothing changes (passive infrastructure — no ctx impact)  |
 * | `replay()`                          | `hasReplay` flips to `true` → unlocks `ctx.sendReplay()`  |
 * | `errors(...)`                       | `errors` is replaced with the new error definition list   |
 * | `outgoing(event, ...)`              | `outgoing` gains the event → `ctx.send()` becomes typed   |
 *                                       | `contract.incoming` also gains the event (client receives it) |
 * | `incoming(event, ...)`              | `contract.outgoing` gains `{ event: payload }` (client sends it) |
 * | `request(event, ...)`               | `contract.requests` gains `{ event: { payload, response } }` |
 * | `generate(stream, ...)`             | `contract.streams` gains the stream entry                 |
 *
 * Everything that is not changed is copied from `TState` unchanged.
 * This ensures the fold never loses previously accumulated information.
 *
 * The deeply nested conditional form (`A extends X ? ... : B extends Y ? ...`)
 * is the standard TypeScript pattern for a multi-branch type-level match.
 */
export type NextState<
  TState extends ScopeStateShape,
  TPrimitive extends FoldablePrimitive,
  // Branch 1: ack() — enable ctx.ack()
> = TPrimitive extends AckPrimitive
  ? {
      readonly kind: TState['kind'];
      readonly outgoing: TState['outgoing'];
      readonly hasAck: true;
      readonly hasReplay: TState['hasReplay'];
      readonly contract: TState['contract'];
      readonly errors: TState['errors'];
      readonly meta: TState['meta'];
      readonly channelNames: TState['channelNames'];
      readonly scheduledTaskIds: TState['scheduledTaskIds'];
    }
  : // Branch 2: passive infrastructure — no ctx change
    TPrimitive extends
        | HeartbeatPrimitive
        | HibernationPrimitive
        | SequencePrimitive
        | DedupPrimitive
        | AnyCustomReplay
    ? {
        readonly kind: TState['kind'];
        readonly outgoing: TState['outgoing'];
        readonly hasAck: TState['hasAck'];
        readonly hasReplay: TState['hasReplay'];
        readonly contract: TState['contract'];
        readonly errors: TState['errors'];
        readonly meta: TState['meta'];
        readonly channelNames: TState['channelNames'];
        readonly scheduledTaskIds: TState['scheduledTaskIds'];
      }
    : // Branch 3: scheduled(taskId) — accumulate task ID for typed ctx.schedule()
      TPrimitive extends ScheduledPrimitive<infer TTaskId, any, any>
      ? {
          readonly kind: TState['kind'];
          readonly outgoing: TState['outgoing'];
          readonly hasAck: TState['hasAck'];
          readonly hasReplay: TState['hasReplay'];
          readonly contract: TState['contract'];
          readonly errors: TState['errors'];
          readonly meta: TState['meta'];
          readonly channelNames: TState['channelNames'];
          readonly scheduledTaskIds: TState['scheduledTaskIds'] | TTaskId;
        }
      : // Branch 4: replay() — enable ctx.sendReplay()
        TPrimitive extends AnyReplay
        ? {
            readonly kind: TState['kind'];
            readonly outgoing: TState['outgoing'];
            readonly hasAck: TState['hasAck'];
            readonly hasReplay: true;
            readonly contract: TState['contract'];
            readonly errors: TState['errors'];
            readonly meta: TState['meta'];
            readonly channelNames: TState['channelNames'];
            readonly scheduledTaskIds: TState['scheduledTaskIds'];
          }
        : // Branch 5: errors(...) — replace the error definition list
          TPrimitive extends AnyErrors
          ? TPrimitive extends ErrorsPrimitive<infer TDefs extends readonly AnyErrorDef[]>
            ? {
                readonly kind: TState['kind'];
                readonly outgoing: TState['outgoing'];
                readonly hasAck: TState['hasAck'];
                readonly hasReplay: TState['hasReplay'];
                readonly contract: TState['contract'];
                readonly errors: TDefs;
                readonly meta: TState['meta'];
                readonly channelNames: TState['channelNames'];
                readonly scheduledTaskIds: TState['scheduledTaskIds'];
              }
            : TState
          : // Branch 6: outgoing(event) — add event to server→client send map and client contract
            TPrimitive extends AnyOutgoing
            ? {
                readonly kind: TState['kind'];
                readonly outgoing: MergeRecords<TState['outgoing'], OutgoingEntry<TPrimitive>>;
                readonly hasAck: TState['hasAck'];
                readonly hasReplay: TState['hasReplay'];
                readonly contract: {
                  incoming: MergeRecords<TState['contract']['incoming'], OutgoingEntry<TPrimitive>>;
                  outgoing: TState['contract']['outgoing'];
                  requests: TState['contract']['requests'];
                  streams: TState['contract']['streams'];
                  channels: TState['contract']['channels'];
                  namespaces: TState['contract']['namespaces'];
                };
                readonly errors: TState['errors'];
                readonly meta: TState['meta'];
                readonly channelNames: TState['channelNames'];
                readonly scheduledTaskIds: TState['scheduledTaskIds'];
              }
            : // Branch 7: incoming(event) — add to client→server contract (client sends it)
              TPrimitive extends AnyIncoming
              ? TPrimitive extends IncomingPrimitive<infer TEvent, infer TPayload, any>
                ? {
                    readonly kind: TState['kind'];
                    readonly outgoing: TState['outgoing'];
                    readonly hasAck: TState['hasAck'];
                    readonly hasReplay: TState['hasReplay'];
                    readonly contract: {
                      incoming: TState['contract']['incoming'];
                      outgoing: MergeRecords<
                        TState['contract']['outgoing'],
                        Record<TEvent, TPayload>
                      >;
                      requests: TState['contract']['requests'];
                      streams: TState['contract']['streams'];
                      channels: TState['contract']['channels'];
                      namespaces: TState['contract']['namespaces'];
                    };
                    readonly errors: TState['errors'];
                    readonly meta: TState['meta'];
                    readonly channelNames: TState['channelNames'];
                    readonly scheduledTaskIds: TState['scheduledTaskIds'];
                  }
                : TState
              : // Branch 8: request(event) — add to contract.requests
                TPrimitive extends AnyRequest
                ? {
                    readonly kind: TState['kind'];
                    readonly outgoing: TState['outgoing'];
                    readonly hasAck: TState['hasAck'];
                    readonly hasReplay: TState['hasReplay'];
                    readonly contract: {
                      incoming: TState['contract']['incoming'];
                      outgoing: TState['contract']['outgoing'];
                      requests: MergeRecords<
                        TState['contract']['requests'],
                        RequestEntry<TPrimitive>
                      >;
                      streams: TState['contract']['streams'];
                      channels: TState['contract']['channels'];
                      namespaces: TState['contract']['namespaces'];
                    };
                    readonly errors: TState['errors'];
                    readonly meta: TState['meta'];
                    readonly channelNames: TState['channelNames'];
                    readonly scheduledTaskIds: TState['scheduledTaskIds'];
                  }
                : // Branch 9: generate(stream) — add to contract.streams
                  TPrimitive extends AnyGenerate
                  ? TPrimitive extends GeneratePrimitive<infer TStream, any, any>
                    ? {
                        readonly kind: TState['kind'];
                        readonly outgoing: TState['outgoing'];
                        readonly hasAck: TState['hasAck'];
                        readonly hasReplay: TState['hasReplay'];
                        readonly contract: {
                          incoming: TState['contract']['incoming'];
                          outgoing: TState['contract']['outgoing'];
                          requests: TState['contract']['requests'];
                          streams: MergeRecords<
                            TState['contract']['streams'],
                            StreamEntry<TStream>
                          >;
                          channels: TState['contract']['channels'];
                          namespaces: TState['contract']['namespaces'];
                        };
                        readonly errors: TState['errors'];
                        readonly meta: TState['meta'];
                        readonly channelNames: TState['channelNames'];
                        readonly scheduledTaskIds: TState['scheduledTaskIds'];
                      }
                    : TState
                  : // Fallback: unknown primitive — leave state unchanged
                    TState;

// ---------------------------------------------------------------------------
// FoldState
// ---------------------------------------------------------------------------

/**
 * Fold an entire tuple of primitives from left to right into one final state.
 *
 * This is a recursive conditional type. It peels one primitive off the front
 * of the tuple, passes it to `NextState`, and recurses on the rest:
 *
 * ```
 * FoldState<[A, B, C]>
 *   = FoldState<[B, C], NextState<ScopeState, A>>
 *   = FoldState<[C],    NextState<...,         B>>
 *   = FoldState<[],     NextState<...,         C>>
 *   = final state
 * ```
 *
 * The second parameter (`TState`) accumulates the running state. The default
 * of `ScopeState` (no arguments) is the clean empty starting state.
 *
 * This is why the order of primitives in the builder chain matters for types —
 * an `outgoing()` declared *after* an `incoming()` won't affect the ctx of
 * that `incoming` handler.
 */
export type FoldState<
  TItems extends readonly FoldablePrimitive[],
  TState extends ScopeStateShape = ScopeState,
> = TItems extends readonly [
  infer THead extends FoldablePrimitive,
  ...infer TTail extends readonly FoldablePrimitive[],
]
  ? FoldState<TTail, NextState<TState, THead>>
  : TState;

// ---------------------------------------------------------------------------
// Typed send / broadcast methods
// ---------------------------------------------------------------------------

/**
 * Type-safe `send` and `broadcast` methods for a handler ctx.
 *
 * Only events declared with `outgoing()` in the same scope are accepted.
 * Calling `ctx.send('unknown-event', ...)` is a type error.
 *
 * `TOutgoing` is the accumulated outgoing event map from `ScopeState.outgoing`.
 */
export interface SendMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send an event to the current connection.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  send<TEvent extends keyof TOutgoing & string>(event: TEvent, payload: TOutgoing[TEvent]): void;

  /**
   * Broadcast an event to all connections in the current scope.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  broadcast<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
  ): void;
}

/**
 * Type-safe `sendTo` method for a handler ctx.
 *
 * Only events declared with `outgoing()` in the same scope are accepted.
 */
export interface SendToMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send an event to every connection that currently has the given tag.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  sendTo<TEvent extends keyof TOutgoing & string>(
    tag: string,
    event: TEvent,
    payload: TOutgoing[TEvent],
  ): void;
}

/**
 * Untyped fallback `sendTo` for scopes that have no `outgoing()` declared.
 *
 * When no outgoing events are known, `sendTo` still exists but accepts any
 * string for the event name and `unknown` for the payload.
 */
export interface GenericSendToMethods {
  /**
   * Send an event to every connection that currently has the given tag.
   */
  sendTo(tag: string, event: string, payload: unknown): void;
}

/**
 * Provides `ctx.id` — the unique ID for the current WebSocket connection.
 */
export interface ConnectionIdentityMethods {
  /**
   * The unique ID for the current websocket connection.
   *
   * Useful when you want to persist a connection reference and target
   * this exact client again later (e.g. `ctx.sendToConnection(id, ...)`).
   */
  readonly id: ConnectionContext['id'];
}

/**
 * Provides `ctx.meta` — per-connection metadata set during the upgrade step.
 *
 * When `.onUpgrade()` returns `{ meta: { userId: string } }`, TypeScript
 * infers `TMeta` as `{ userId: string }` and all handler contexts get
 * `ctx.meta.userId: string` instead of `Record<string, unknown>`.
 */
export interface ConnectionMetaMethods<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Per-connection metadata attached during the WebSocket upgrade step.
   *
   * This is where auth or session information usually lives. Handlers that
   * run after the upgrade can read it here.
   */
  readonly meta: TMeta;
}

/**
 * Provides `ctx.bufferedAmount` — bytes waiting to be sent on this connection.
 */
export interface BufferedAmountMethods {
  /**
   * The number of bytes still waiting to be sent on this connection.
   *
   * Useful for detecting back-pressure: if this is large, the client is not
   * keeping up and you should slow down or skip non-critical sends.
   */
  readonly bufferedAmount: ConnectionContext['bufferedAmount'];
}

/**
 * Provides `ctx.latency` — measured round-trip time for this connection.
 */
export interface LatencyMethods {
  /**
   * The latest measured round-trip latency for this connection in milliseconds.
   *
   * This is `null` until wskit has completed at least one ping/pong exchange.
   */
  readonly latency: ConnectionContext['latency'];
}

/**
 * Provides `ctx.quality` — a human-readable connection health label.
 */
export interface QualityMethods {
  /**
   * A simple health label derived from recent ping/pong latency measurements.
   *
   * Use this for easy quality checks. If you need exact numbers, use `latency`.
   */
  readonly quality: ConnectionContext['quality'];
}

/**
 * Provides `ctx.tags` — the current tag set for this connection.
 */
export interface ConnectionTagsMethods {
  /**
   * The current tags attached to this connection.
   *
   * Tags let you group connections and send events to all of them at once
   * with `ctx.sendTo(tag, event, payload)`.
   */
  readonly tags: ConnectionContext['tags'];
}

/**
 * Provides `ctx.tag(label)` — attach a tag to this connection.
 */
export interface TagMethods {
  /**
   * Attach a tag to the current connection.
   *
   * Tags let you target groups of related connections later with
   * `ctx.sendTo(tag, event, payload)`.
   */
  tag(label: string): ReturnType<ConnectionContext['tag']>;
}

/**
 * Provides `ctx.untag(label)` — remove a tag from this connection.
 */
export interface UntagMethods {
  /**
   * Remove a tag from the current connection.
   *
   * Call this when the connection should no longer be part of a group you
   * are targeting with `sendTo`.
   */
  untag(label: string): ReturnType<ConnectionContext['untag']>;
}

/**
 * Provides `ctx.ack()` — confirm receipt of the current message.
 *
 * Only present when `ack()` is registered in the top-level scope.
 */
export interface AckMethods {
  /**
   * Confirm receipt of the current incoming message.
   *
   * This is only available when `ack()` is registered at the top level.
   * Calling it sends a lightweight acknowledgement frame back to the client.
   */
  ack(): void;
}

/**
 * The wire metadata attached to every replay message.
 *
 * `seq`       — the sequence number for ordering on the client side
 * `messageId` — a unique ID for deduplication
 * `channel`   — optional channel scope the replay is pinned to
 */
export interface ReplayWire {
  readonly seq: number;
  readonly messageId: string;
  readonly channel?: string;
}

/**
 * Provides `ctx.sendReplay(...)` — send a message with explicit replay wire metadata.
 *
 * Only present when `replay()` is registered in this scope.
 */
export interface ReplayMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send a message that the client can replay after reconnecting.
   *
   * Provide explicit wire metadata (`seq`, `messageId`, optional `channel`)
   * so the client can deduplicate and reorder messages correctly.
   */
  sendReplay<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
    wire: ReplayWire,
  ): void;
}

/**
 * Provides `ctx.schedule()`, `ctx.cancelScheduled()`, and `ctx.setAlarm()`.
 *
 * These are always available on connection handler contexts — they delegate
 * to the engine's scheduled-task infrastructure and the platform's alarm API.
 */
export interface ScheduleMethods<TScheduledTaskIds extends string = string> {
  schedule(taskId: TScheduledTaskIds, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: TScheduledTaskIds, filter?: Record<string, unknown>): void;
  setAlarm(time: number): void;
}

/**
 * Provides `ctx.namespace` inside namespace-scoped handlers.
 *
 * When outgoing events are known, `send` and `broadcast` are typed to only
 * accept events declared inside the namespace.
 */
export interface NamespaceScopeMethods<
  TOutgoing extends Record<string, any> = Record<string, any>,
> {
  readonly namespace: {
    readonly name: string;
    send<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): boolean;
    broadcast<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): void;
  };
}

/**
 * Provides `ctx.channel` inside channel-scoped handlers.
 *
 * When outgoing events are known, `send` and `broadcast` are typed to only
 * accept events declared inside the channel.
 */
export interface ChannelScopeMethods<TOutgoing extends Record<string, any> = Record<string, any>> {
  readonly channel: {
    readonly name: string;
    send<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): boolean;
    broadcast<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): void;
  };
}

/**
 * Provides `ctx.channels` — manage channel membership from any handler.
 *
 * When channel names are known (from `.channel()` calls), the `name` parameter
 * on `members()` and `kick()` is typed as the union of registered channel
 * names. Static channels produce exact string literals; dynamic channels
 * (via `scope()`) widen to `string & {}` so any string is accepted but
 * autocomplete still suggests known names.
 */
export interface ChannelsMethods<TChannelNames extends string = string> {
  /**
   * Manage channel membership from any handler — list members, kick
   * connections by tag. Available everywhere, not just inside channel-scoped
   * handlers.
   */
  readonly channels: ChannelManager<TChannelNames>;
}

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
> = TKind extends 'namespace'
  ? NamespaceScopeMethods<TOutgoing>
  : TKind extends 'channel'
    ? ChannelScopeMethods<TOutgoing>
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
 * | Slice                   | When present                                               |
 * |-------------------------|------------------------------------------------------------|
 * | `SendApi`               | Only when the scope has at least one `outgoing()` event    |
 * | `SendToApi`             | Always (typed when outgoing events exist, generic otherwise)|
 * | `ConnectionIdentity...` | Always — `ctx.id`                                          |
 * | `ConnectionMeta...`     | Always — `ctx.meta`                                        |
 * | `BufferedAmount...`     | Always — `ctx.bufferedAmount`                              |
 * | `Latency...`            | Always — `ctx.latency`                                     |
 * | `Quality...`            | Always — `ctx.quality`                                     |
 * | `ConnectionTags...`     | Always — `ctx.tags`                                        |
 * | `TagMethods`            | Always — `ctx.tag(label)`                                  |
 * | `UntagMethods`          | Always — `ctx.untag(label)`                                |
 * | `AckApi`                | Only in top-level scope when `ack()` is registered         |
 * | `ReplayApi`             | Only when `replay()` is registered                         |
 * | `ChannelsMethods`       | Always — `ctx.channels`                                    |
 * | `ScopeExtras`           | `ctx.namespace.name` or `ctx.channel.name` based on kind   |
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
  ScopeExtras<TState['kind'], TState['outgoing']>;

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
  ScopeExtras<TState['kind'], TState['outgoing']>;

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

// ---------------------------------------------------------------------------
// Extraction helpers — read a single field out of a folded state
// ---------------------------------------------------------------------------

/**
 * Read the client contract out of a fully folded scope state.
 *
 * Shorthand for `TState['contract']`. Used when other types only need the
 * contract and don't care about the rest of the state.
 */
export type ContractFromState<TState extends ScopeStateShape> = TState['contract'];

/**
 * Read the declared error list out of a fully folded scope state.
 *
 * Shorthand for `TState['errors']`.
 */
export type ErrorsFromState<TState extends ScopeStateShape> = TState['errors'];

// ---------------------------------------------------------------------------
// FoldableItemsOf / ContractFromItems / ErrorsFromItems
// ---------------------------------------------------------------------------

/**
 * Filter a mixed tuple down to just the primitives that the fold engine can
 * process, discarding anything else (e.g. scope primitives like `namespace()`
 * and `channel()` that run their own nested folds).
 *
 * This is done recursively: peek at the head of the tuple, keep it if it is
 * a `FoldablePrimitive`, skip it otherwise, then recurse on the tail.
 */
export type FoldableItemsOf<TItems extends readonly unknown[]> = TItems extends readonly [
  infer THead,
  ...infer TTail,
]
  ? THead extends FoldablePrimitive
    ? readonly [THead, ...FoldableItemsOf<TTail>]
    : FoldableItemsOf<TTail>
  : readonly [];

/**
 * Compute the full client contract directly from a raw tuple of builder items.
 *
 * Items that are not foldable (e.g. `namespace()`, `channel()`) are filtered
 * out automatically before folding. The fold starts from the clean empty state
 * for the given `TKind`.
 *
 * This is the entry point used by `InferClient` to derive the contract from
 * the top-level primitive list.
 */
export type ContractFromItems<
  TItems extends readonly unknown[],
  TKind extends ScopeKind = 'top',
> = ContractFromState<FoldState<FoldableItemsOf<TItems>, ScopeState<TKind>>>;

/**
 * Compute the declared error list directly from a raw tuple of builder items.
 *
 * Like `ContractFromItems`, non-foldable items are skipped automatically.
 */
export type ErrorsFromItems<
  TItems extends readonly unknown[],
  TKind extends ScopeKind = 'top',
> = ErrorsFromState<FoldState<FoldableItemsOf<TItems>, ScopeState<TKind>>>;
