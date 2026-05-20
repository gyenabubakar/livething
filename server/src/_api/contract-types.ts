/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Derives the structured `Contract` shape from a `definitions` tuple. Each
 * section (`incoming`, `outgoing`, `requests`, `streams`, `scheduled`,
 * `channels`, `namespaces`) becomes a record keyed by definition name.
 */

import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type {
  ChannelDef,
  Definition,
  IncomingDef,
  NamespaceDef,
  NudgeDef,
  OutgoingDef,
  RecordedStreamDef,
  RequestDef,
  ResumableStreamDef,
  ScheduledDef,
  StreamDef,
  TypeMarker,
} from './definitions.ts';

// ---------------------------------------------------------------------------
// Single-pass categorizer
//
// One tail-recursive walk over the definitions tuple builds a record of all
// per-kind slots in a single instantiation. Previously each slot was its own
// mapped-type-over-tuple walk plus a contravariant MergeUnion collapse — seven
// walks per contract level, repeating for every nested channel/namespace.
// The accumulator pattern below does the same job in one pass; TS memoizes
// `Categorize<D>` so downstream slot lookups (`Contract['incoming']`, etc.)
// are O(1) indexes into the cached record.
// ---------------------------------------------------------------------------

type NudgesMap<TNudges extends readonly NudgeDef<string, any>[]> = {
  [K in TNudges[number] as K extends NudgeDef<infer N, any> ? N : never]: K extends NudgeDef<
    any,
    infer P
  >
    ? P
    : never;
};

type ChannelKeyFromPattern<P> = P extends string
  ? P
  : P extends ScopeDeclaration<infer K>
    ? K
    : never;

interface EmptyCats {
  readonly incoming: {};
  readonly outgoing: {};
  readonly requests: {};
  readonly streams: {};
  readonly resumableStreams: {};
  readonly recordedStreams: {};
  readonly scheduled: {};
  readonly channels: {};
  readonly namespaces: {};
}

type AddOne<Acc, D> =
  D extends IncomingDef<infer N, infer P>
    ? Acc & { readonly incoming: Record<N, P> }
    : D extends OutgoingDef<infer N, infer P>
      ? Acc & { readonly outgoing: Record<N, P> }
      : D extends RequestDef<infer N, infer P, infer R>
        ? Acc & { readonly requests: Record<N, { payload: P; response: R }> }
        : D extends StreamDef<infer N, infer P, infer C, infer Nu>
          ? Acc & {
              readonly streams: Record<
                N,
                { payload: P; chunk: C; nudges: NudgesMap<Nu>; broadcast: boolean }
              >;
            }
          : D extends ResumableStreamDef<infer N, infer P, infer C, infer Cu, infer Nu>
            ? Acc & {
                readonly resumableStreams: Record<
                  N,
                  { payload: P; chunk: C; cursor: Cu; nudges: NudgesMap<Nu> }
                >;
              }
            : D extends RecordedStreamDef<infer N, infer P, infer C, infer Nu>
              ? Acc & {
                  readonly recordedStreams: Record<
                    N,
                    { payload: P; chunk: C; nudges: NudgesMap<Nu> }
                  >;
                }
              : D extends ScheduledDef<infer I, infer Dt>
                ? Acc & { readonly scheduled: Record<I, Dt> }
                : D extends ChannelDef<infer Pat, infer Defs>
                  ? Acc & {
                      readonly channels: Record<ChannelKeyFromPattern<Pat>, ChannelContract<Defs>>;
                    }
                  : D extends NamespaceDef<infer N, infer Defs>
                    ? Acc & { readonly namespaces: Record<N, NamespaceContract<Defs>> }
                    : Acc;

type Categorize<TDefs extends readonly Definition[], Acc = EmptyCats> = TDefs extends readonly [
  infer Head,
  ...infer Tail extends readonly Definition[],
]
  ? Categorize<Tail, AddOne<Acc, Head>>
  : Acc;

// ---------------------------------------------------------------------------
// Sub-contracts
// ---------------------------------------------------------------------------

export type ChannelContract<TDefs extends readonly Definition[] = readonly Definition[]> = Pick<
  Categorize<TDefs>,
  'incoming' | 'outgoing' | 'requests' | 'streams' | 'resumableStreams' | 'recordedStreams'
>;

export type NamespaceContract<TDefs extends readonly Definition[] = readonly Definition[]> = Pick<
  Categorize<TDefs>,
  'incoming' | 'outgoing' | 'requests' | 'streams' | 'resumableStreams' | 'recordedStreams'
>;

// ---------------------------------------------------------------------------
// ContractConfig — the shape passed to contract()
// ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Configuration accepted under `replay:` on contract / channel.
 *
 * - `true` — turn on built-in replay with default options.
 * - `false` — explicitly opt out (used inside a channel to skip cascade).
 * - An options object — built-in replay with the given retention / exclude /
 *   snapshot configuration. Mirrors the `ReplayOptions` shape from the engine.
 *
 * Custom replay strategies (those with their own storage + `onReplay`) are
 * registered on the implementation side via `.customReplay(...)` on the
 * implementer (top-level) or on a channel sub-implementer.
 */
export type ReplayConfig = boolean | ReplayOptionsConfig;

export interface ReplayOptionsConfig {
  readonly type?: 'history' | 'snapshot';
  readonly durability?: 'strict' | 'best-effort';
  readonly retention?: { readonly maxAgeMs?: number; readonly maxMessages?: number };
  readonly exclude?: readonly string[];
  readonly snapshotKey?: (event: string, payload: Record<string, unknown>) => string;
  readonly reduce?: (
    previous: { event: string; payload: Record<string, unknown> } | null,
    next: { event: string; payload: Record<string, unknown> },
  ) => { event: string; payload: Record<string, unknown> } | null;
}

export interface ContractConfig {
  readonly ack?: boolean;
  readonly replay?: ReplayConfig;
  readonly persistence?: boolean;
  readonly sequence?: boolean | { persist?: boolean };
  readonly dedup?: boolean | { cap?: number };
  readonly hibernation?: boolean;
  readonly heartbeat?: boolean | HeartbeatOptions;
  readonly binary?: boolean;
  /**
   * Top-level rate-limit rule. Applies to every event in every scope unless a
   * channel, namespace, or per-handler override replaces it. `{ enabled: false }`
   * here means "no enforcement anywhere by default" — children can still opt in.
   */
  readonly rateLimit?: RateLimitConfig;

  readonly meta?: TypeMarker<any>;
  readonly tagGroups?: {
    readonly ephemeral?: readonly string[];
    readonly persistent?: readonly string[];
  };
  readonly errors?: readonly any[];
  /**
   * Module instances mounted onto this server. Each entry is the result of
   * calling a module factory — `Drizzle({ migrate: true })` etc. The module
   * registers its own events, scheduled tasks, and errors at boot. The
   * module API is accessed inside handlers via `<Module>.use(ctx)`.
   */
  readonly modules?: readonly any[];
  readonly definitions: readonly Definition[];
}

// ---------------------------------------------------------------------------
// Extractors that read directly from a const-narrowed config
// ---------------------------------------------------------------------------

type FeatureFromConfig<TConfig> =
  | (TConfig extends { ack: true } ? 'ack' : never)
  | (TConfig extends { replay: true | ReplayOptionsConfig } ? 'replay' : never)
  | (TConfig extends { persistence: true } ? 'persistence' : never)
  | (TConfig extends { sequence: true | { persist?: boolean } } ? 'sequence' : never)
  | (TConfig extends { dedup: true | { cap?: number } } ? 'dedup' : never)
  | (TConfig extends { hibernation: true } ? 'hibernation' : never)
  | (TConfig extends { heartbeat: true | HeartbeatOptions } ? 'heartbeat' : never)
  | (TConfig extends { binary: true } ? 'binary' : never);

type MetaFromConfig<TConfig> = TConfig extends { meta: TypeMarker<infer M> }
  ? M
  : Record<string, unknown>;

type EphemeralTagsFromConfig<TConfig> = TConfig extends {
  tagGroups: { ephemeral: readonly (infer E)[] };
}
  ? E
  : never;

type PersistentTagsFromConfig<TConfig> = TConfig extends {
  tagGroups: { persistent: readonly (infer P)[] };
}
  ? P
  : never;

type ErrorMapFromConfig<TConfig> = TConfig extends { errors: infer TErrors }
  ? TErrors extends readonly any[]
    ? {
        [TDef in TErrors[number] as TDef extends { code: infer C extends string }
          ? C
          : never]: TDef extends { __detail?: infer D } ? D : unknown;
      }
    : {}
  : {};

type DefinitionsFromConfig<TConfig> = TConfig extends { definitions: infer D }
  ? D extends readonly Definition[]
    ? D
    : readonly []
  : readonly [];

// ---------------------------------------------------------------------------
// Contract — the final type produced by contract()
// ---------------------------------------------------------------------------

type ContractCats<TConfig> = Categorize<DefinitionsFromConfig<TConfig>>;

export interface Contract<TConfig = unknown, TEnv = unknown> {
  readonly __wskit_contract: true;
  readonly __config: TConfig;
  readonly name: string;

  readonly incoming: ContractCats<TConfig>['incoming'];
  readonly outgoing: ContractCats<TConfig>['outgoing'];
  readonly requests: ContractCats<TConfig>['requests'];
  readonly streams: ContractCats<TConfig>['streams'];
  readonly resumableStreams: ContractCats<TConfig>['resumableStreams'];
  readonly recordedStreams: ContractCats<TConfig>['recordedStreams'];
  readonly channels: ContractCats<TConfig>['channels'];
  readonly namespaces: ContractCats<TConfig>['namespaces'];
  readonly scheduled: ContractCats<TConfig>['scheduled'];
  readonly errors: ErrorMapFromConfig<TConfig>;
  readonly features: FeatureFromConfig<TConfig>;
  readonly meta: MetaFromConfig<TConfig>;
  readonly env: TEnv;
  readonly tagGroups: {
    ephemeral: EphemeralTagsFromConfig<TConfig>;
    persistent: PersistentTagsFromConfig<TConfig>;
  };

  readonly definitions: DefinitionsFromConfig<TConfig>;
}
