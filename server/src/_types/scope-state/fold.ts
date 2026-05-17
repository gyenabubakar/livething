/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * The running type state for a wskit builder scope.
 *
 * As you chain builder calls, wskit keeps track of what has been declared so
 * far in one shared type: outgoing events, requests, errors, replay support,
 * channel names, and more. That running state is what powers the final
 * handler `ctx` type and the client contract used by `InferClient`.
 */
import type { ContractFromState, ErrorsFromState } from '~/_types/scope-state/extract.ts';
import type { ScheduledTaskDefinition } from '~/_types/scope-state/methods.ts';
import type { AckPrimitive } from '~/ack/ack.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { HibernationPrimitive } from '~/hibernation/hibernation.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { PersistencePrimitive } from '~/persistence/persistence.ts';
import type { CustomReplayPrimitive } from '~/replay/custom/custom.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ScheduledPrimitive } from '~/scheduled/scheduled.ts';
import type { SequencePrimitive } from '~/sequence/sequence.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/stream/stream.ts';
import type { TagGroupsPrimitive } from '~/tags/tags.ts';

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
// How wskit turns registered primitives into the final handler/context types
// ---------------------------------------------------------------------------
//
// The builder's fluent API produces a tuple of primitives:
//
//   // (assume `withAck` has been applied to enable `.ack()`)
//   server('chat')
//     .ack()
//     .outgoing(event('typing', v.object({ roomId: v.string() })))
//     .incoming(event('message', v.object({ text: v.string() })), handler)
//
// Internally this becomes something like:
//
//   readonly [
//     AckPrimitive,
//     OutgoingPrimitive<'typing', ...>,
//     IncomingPrimitive<'message', ...>
//   ]
//
// To derive the correctly typed ctx for each handler, wskit walks through
// that list from left to right. Each primitive updates the running state:
//
//   ScopeState (empty)
//     → NextState<state, AckPrimitive>          hasAck: true
//     → NextState<state, OutgoingPrimitive>      outgoing: { typing: ... }
//     → NextState<state, IncomingPrimitive>      contract.outgoing: { message: ... }
//
// The final state is then passed to `HandlerCtxFromState` to produce the ctx
// type that developers see in their handler callbacks.
//
// This only affects types. It does not add runtime work.

// ---------------------------------------------------------------------------
// FoldablePrimitive
// ---------------------------------------------------------------------------

/**
 * Every primitive shape that this type-state system knows how to process.
 *
 * When the builder collects primitives, each one is checked against this
 * union. Matching primitives update the running type state; others are
 * ignored here but still exist at runtime.
 *
 * `namespace()` and `channel()` are excluded here because they each build
 * their own nested scope state from their child primitives.
 */
export type FoldablePrimitive =
  | AckPrimitive
  | HeartbeatPrimitive
  | HibernationPrimitive
  | PersistencePrimitive
  | TagGroupsPrimitive
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
 * The client-facing contract built up as primitives are registered.
 *
 * Each handler primitive (`incoming`, `request`, `generate`) adds entries
 * here as the builder grows. The final `contract` value is what
 * `InferClient` uses to produce the client SDK types.
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
  readonly staticChannelNames: string;
  readonly channelFamilyKeys: string;
  readonly channelOutgoingByKey: Record<string, Record<string, any>>;
  readonly scheduledTasks: Record<string, ScheduledTaskDefinition<any, any>>;
  readonly env: object;
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
 * The full running state for one scope as primitives are registered.
 *
 * Start at the default empty state and update it once for each primitive
 * registered in the scope.
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
 * - `scheduledTasks`    — scheduled task metadata keyed by task ID for typed `ctx.schedule()`
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
  TScheduledTasks extends Record<string, ScheduledTaskDefinition<any, any>> = {},
  TEnv extends object = Record<string, unknown>,
  TStaticChannelNames extends string = never,
  TChannelFamilyKeys extends string = never,
  TChannelOutgoingByKey extends Record<string, Record<string, any>> = {},
> = {
  readonly kind: TKind;
  readonly outgoing: TOutgoing;
  readonly hasAck: THasAck;
  readonly hasReplay: THasReplay;
  readonly contract: TContract;
  readonly errors: TErrors;
  readonly meta: TMeta;
  readonly channelNames: TChannelNames;
  readonly staticChannelNames: TStaticChannelNames;
  readonly channelFamilyKeys: TChannelFamilyKeys;
  readonly channelOutgoingByKey: TChannelOutgoingByKey;
  readonly scheduledTasks: TScheduledTasks;
  readonly env: TEnv;
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
 * readonly [
 *   nudge('cancel'),
 *   nudge('add-context', v.object({ hint: v.string() }))
 * ]
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
 * This is the heart of the scope-state system. Each branch describes what one
 * primitive adds or changes:
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
 * Everything else is carried over unchanged so the builder never loses
 * information it learned from earlier calls.
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
      readonly staticChannelNames: TState['staticChannelNames'];
      readonly channelFamilyKeys: TState['channelFamilyKeys'];
      readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
      readonly scheduledTasks: TState['scheduledTasks'];
      readonly env: TState['env'];
    }
  : TPrimitive extends TagGroupsPrimitive
    ? {
        readonly kind: TState['kind'];
        readonly outgoing: TState['outgoing'];
        readonly hasAck: TState['hasAck'];
        readonly hasReplay: TState['hasReplay'];

        readonly contract: TState['contract'];
        readonly errors: TState['errors'];
        readonly meta: TState['meta'];
        readonly channelNames: TState['channelNames'];
        readonly staticChannelNames: TState['staticChannelNames'];
        readonly channelFamilyKeys: TState['channelFamilyKeys'];
        readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
        readonly scheduledTasks: TState['scheduledTasks'];
        readonly env: TState['env'];
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
          readonly staticChannelNames: TState['staticChannelNames'];
          readonly channelFamilyKeys: TState['channelFamilyKeys'];
          readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
          readonly scheduledTasks: TState['scheduledTasks'];
          readonly env: TState['env'];
        }
      : // Branch 3: scheduled(taskId) — accumulate task metadata for typed ctx.schedule()
        TPrimitive extends ScheduledPrimitive<infer TTaskId, infer TData, infer THasData, any>
        ? {
            readonly kind: TState['kind'];
            readonly outgoing: TState['outgoing'];
            readonly hasAck: TState['hasAck'];
            readonly hasReplay: TState['hasReplay'];

            readonly contract: TState['contract'];
            readonly errors: TState['errors'];
            readonly meta: TState['meta'];
            readonly channelNames: TState['channelNames'];
            readonly staticChannelNames: TState['staticChannelNames'];
            readonly channelFamilyKeys: TState['channelFamilyKeys'];
            readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
            readonly scheduledTasks: MergeRecords<
              TState['scheduledTasks'],
              Record<TTaskId, ScheduledTaskDefinition<TData, THasData>>
            >;
            readonly env: TState['env'];
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
              readonly staticChannelNames: TState['staticChannelNames'];
              readonly channelFamilyKeys: TState['channelFamilyKeys'];
              readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
              readonly scheduledTasks: TState['scheduledTasks'];
              readonly env: TState['env'];
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
                  readonly staticChannelNames: TState['staticChannelNames'];
                  readonly channelFamilyKeys: TState['channelFamilyKeys'];
                  readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
                  readonly scheduledTasks: TState['scheduledTasks'];
                  readonly env: TState['env'];
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
                    incoming: MergeRecords<
                      TState['contract']['incoming'],
                      OutgoingEntry<TPrimitive>
                    >;
                    outgoing: TState['contract']['outgoing'];
                    requests: TState['contract']['requests'];
                    streams: TState['contract']['streams'];
                    channels: TState['contract']['channels'];
                    namespaces: TState['contract']['namespaces'];
                  };
                  readonly errors: TState['errors'];
                  readonly meta: TState['meta'];
                  readonly channelNames: TState['channelNames'];
                  readonly staticChannelNames: TState['staticChannelNames'];
                  readonly channelFamilyKeys: TState['channelFamilyKeys'];
                  readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
                  readonly scheduledTasks: TState['scheduledTasks'];
                  readonly env: TState['env'];
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
                      readonly staticChannelNames: TState['staticChannelNames'];
                      readonly channelFamilyKeys: TState['channelFamilyKeys'];
                      readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
                      readonly scheduledTasks: TState['scheduledTasks'];
                      readonly env: TState['env'];
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
                      readonly staticChannelNames: TState['staticChannelNames'];
                      readonly channelFamilyKeys: TState['channelFamilyKeys'];
                      readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
                      readonly scheduledTasks: TState['scheduledTasks'];
                      readonly env: TState['env'];
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
                          readonly staticChannelNames: TState['staticChannelNames'];
                          readonly channelFamilyKeys: TState['channelFamilyKeys'];
                          readonly channelOutgoingByKey: TState['channelOutgoingByKey'];
                          readonly scheduledTasks: TState['scheduledTasks'];
                          readonly env: TState['env'];
                        }
                      : TState
                    : // Fallback: unknown primitive — leave state unchanged
                      TState;

// ---------------------------------------------------------------------------
// FoldState
// ---------------------------------------------------------------------------

/**
 * Turn a whole list of primitives into one final scope state.
 *
 * Read this as: start from an empty scope, then apply `NextState` once for
 * each primitive in order:
 *
 * ```
 * FoldState<[A, B, C]>
 *   = FoldState<[B, C], NextState<ScopeState, A>>
 *   = FoldState<[C],    NextState<...,         B>>
 *   = FoldState<[],     NextState<...,         C>>
 *   = final state
 * ```
 *
 * The second parameter (`TState`) holds the running state. By default it
 * starts as an empty `ScopeState`.
 *
 * This is why builder order matters for types: an `outgoing()` declared
 * *after* an `incoming()` will not affect that earlier handler's ctx type.
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
// FoldableItemsOf / ContractFromItems / ErrorsFromItems
// ---------------------------------------------------------------------------

/**
 * Filter a mixed tuple down to just the primitives that affect scope state,
 * discarding anything else (such as `namespace()` and `channel()`, which each
 * build their own nested scope state).
 *
 * Read this as: walk through the tuple, keep the items that matter for state,
 * and skip the rest.
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
 * Compute the full client contract from a raw tuple of builder items.
 *
 * Items that do not affect scope state are filtered out automatically first.
 * Then wskit starts from an empty scope state and walks through the remaining
 * items to build the final contract.
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
