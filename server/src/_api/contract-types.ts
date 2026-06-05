/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { TagsConfig } from '~/tags/tags.ts';
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
// One tail-recursive walk over the definitions tuple builds a record of every
// per-kind slot in a single instantiation. TS memoizes `Categorize<D>` so
// downstream slot lookups (`Contract['incoming']`, etc.) are O(1) indexes into
// the cached record.
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

// The `{name}` param shape captured by a `scope()` template. Static channels
// (string pattern) have no params.
type ParamsFromPattern<P> = P extends ScopeDeclaration<string, infer Params> ? Params : {};

// 'dynamic' for a `scope()` family (one entry matches many concrete names),
// 'fixed' for a string-pattern channel. This is the reliable family signal:
// a scope() template may declare zero `{name}` params, so non-empty params
// alone can't tell the two apart.
type AddressingFromPattern<P> = P extends ScopeDeclaration<string> ? 'dynamic' : 'fixed';

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
              readonly streams: Record<N, { payload: P; chunk: C; nudges: NudgesMap<Nu> }>;
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
                : D extends ChannelDef<infer Pat, infer Defs, infer TCheckPayload>
                  ? Acc & {
                      readonly channels: Record<
                        ChannelKeyFromPattern<Pat>,
                        ChannelContract<
                          Defs,
                          TCheckPayload,
                          ParamsFromPattern<Pat>,
                          AddressingFromPattern<Pat>
                        >
                      >;
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

export type ChannelContract<
  TDefs extends readonly Definition[] = readonly Definition[],
  TCheckPayload = unknown,
  TParams = Record<string, string>,
  TAddressing extends 'fixed' | 'dynamic' = 'fixed' | 'dynamic',
> = Pick<
  Categorize<TDefs>,
  'incoming' | 'outgoing' | 'requests' | 'streams' | 'resumableStreams' | 'recordedStreams'
> &
  (unknown extends TCheckPayload ? {} : { readonly subscribePayload: TCheckPayload }) & {
    /** The `{name}` captures from the `scope()` template, surfaced as `ctx.channel.params`. */
    readonly params: TParams;
    /**
     * Whether this channel is a single fixed channel or a dynamic `scope()`
     * family. Read by `InferClient` to give the client the right channel API
     * shape; never used at runtime.
     */
    readonly __addressing: TAddressing;
  };

export type NamespaceContract<TDefs extends readonly Definition[] = readonly Definition[]> = Pick<
  Categorize<TDefs>,
  'incoming' | 'outgoing' | 'requests' | 'streams' | 'resumableStreams' | 'recordedStreams'
>;

// ---------------------------------------------------------------------------
// ContractConfig — the shape passed to contract()
// ---------------------------------------------------------------------------

export interface KeepaliveOptions {
  /** How often the server sends a keepalive ping, in ms. Must be < idleTimeoutMs. */
  readonly pingIntervalMs: number;
  /** Max silence (any frame resets it) before the connection is closed, in ms. */
  readonly idleTimeoutMs: number;
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
  readonly sequence?: boolean | { persist?: boolean; batchSize?: number };
  readonly dedup?: boolean | { cap?: number };
  readonly hibernation?: boolean;
  readonly keepalive?: KeepaliveOptions;
  readonly binary?: boolean;
  /**
   * Top-level rate-limit rule. Applies to every event in every scope unless a
   * channel, namespace, or per-handler override replaces it. `{ enabled: false }`
   * here means "no enforcement anywhere by default" — children can still opt in.
   */
  readonly rateLimit?: RateLimitConfig;

  /**
   * Phantom marker for the env type the adapter injects into every handler
   * context (e.g. Cloudflare Workers `Env`). Use `env: t<MyEnv>()` so TS can
   * infer the env shape without an explicit generic argument on `contract()`.
   */
  readonly env?: TypeMarker<any>;

  readonly meta?: TypeMarker<any>;
  /**
   * Declare tag groups and the type of each group's value. Each builder call
   * names a group and gives its value type via `t<T>()` (type only) or a
   * Standard Schema (type plus runtime validation on `add()`).
   *
   * ```ts
   * tags: (ephemeral, persistent) => [
   *   ephemeral('user', t<string>()),
   *   ephemeral('role', t<'admin' | 'moderator' | 'viewer'>()),
   *   persistent('favourite', t<string>()),
   * ]
   * ```
   */
  readonly tags?: TagsConfig;
  readonly errors?: readonly any[];
  /**
   * Plugin instances mounted onto this server. Each entry is the result of
   * calling a plugin factory — `Drizzle({ migrate: true })` etc. The plugin
   * registers its own events, scheduled tasks, and errors at boot. The
   * plugin API is accessed inside handlers via `<Plugin>.use(ctx)`.
   *
   * Typed as `readonly unknown[]` so the const-narrowed config preserves
   * each plugin instance's literal `id` and per-plugin generic types. The
   * extractors below (`PluginOutgoingFromPlugins`, etc.) walk the tuple and
   * fold the surface into the contract type. A loose-typed entry that is
   * not a plugin instance simply contributes `{}` to the merged types.
   */
  readonly plugins?: readonly unknown[];
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
  | (TConfig extends { keepalive: KeepaliveOptions } ? 'keepalive' : never)
  | (TConfig extends { binary: true } ? 'binary' : never);

type MetaFromConfig<TConfig> = TConfig extends { meta: TypeMarker<infer M> }
  ? M
  : Record<string, unknown>;

export type EnvFromConfig<TConfig> = TConfig extends { env: TypeMarker<infer E> }
  ? E
  : Record<string, unknown>;

type TagDefsFromConfig<TConfig> = TConfig extends { tags: (...args: any[]) => infer R }
  ? R extends readonly any[]
    ? R[number]
    : never
  : never;

type EphemeralTagMapFromConfig<TConfig> = {
  [D in TagDefsFromConfig<TConfig> as D extends { kind: 'ephemeral'; name: infer N extends string }
    ? N
    : never]: D extends { _value?: infer V } ? (V extends string ? V : string) : string;
};

type PersistentTagMapFromConfig<TConfig> = {
  [D in TagDefsFromConfig<TConfig> as D extends { kind: 'persistent'; name: infer N extends string }
    ? N
    : never]: D extends { _value?: infer V } ? (V extends string ? V : string) : string;
};

type ErrorMapFromConfig<TConfig> = TConfig extends { errors: infer TErrors }
  ? TErrors extends readonly any[]
    ? {
        [TDef in TErrors[number] as TDef extends { code: infer C extends string }
          ? C
          : never]: TDef extends ErrorDef<string, infer D> ? D : unknown;
      }
    : {}
  : {};

type DefinitionsFromConfig<TConfig> = TConfig extends { definitions: infer D }
  ? D extends readonly Definition[]
    ? D
    : readonly []
  : readonly [];

// ---------------------------------------------------------------------------
// Plugin extractors — fold each mounted plugin's wire surface into the
// contract's outgoing and errors maps so InferClient sees plugin-prefixed
// events alongside the contract's own. Plugin scheduled tasks are server-side
// only (the client never schedules them) and intentionally stay out.
// ---------------------------------------------------------------------------

type PluginsFromConfig<TConfig> = TConfig extends { plugins: infer P }
  ? P extends readonly any[]
    ? P
    : readonly []
  : readonly [];

/**
 * Map every plugin's `outgoing` record into a `__<pluginId>:<event>` keyed
 * record, then merge across the whole tuple. A plugin id of `'acme:drizzle'`
 * with `outgoing: { 'tx-committed': Tx }` produces `{ '__acme:drizzle:tx-committed': Tx }`.
 */
type PluginOutgoingFromPlugins<TPlugins> = UnionToIntersection<
  TPlugins extends readonly (infer P)[]
    ? P extends { readonly id: infer TId extends string; readonly outgoing: infer TOut }
      ? {
          [E in keyof TOut as E extends string ? `__${TId}:${E}` : never]: TOut[E];
        }
      : {}
    : {}
>;

/**
 * Map every plugin's declared error defs into the contract's error map shape
 * so the client SDK can match plugin error codes via the typed catalog.
 */
/**
 * Map every plugin's declared scheduled tasks into the contract's scheduled
 * map under the wire-prefixed task id `__<pluginId>:<task>`. Server-side
 * `ctx.schedule(...)` reads task ids off `Contract.scheduled`, so without
 * this fold a plugin task id required a cast at every callsite. Data is
 * typed as `unknown` because plugin scheduled defs do not carry data
 * generics through the high-level `plugin()` factory.
 */
type PluginScheduledFromPlugins<TPlugins> = UnionToIntersection<
  TPlugins extends readonly (infer P)[]
    ? P extends { readonly id: infer TId extends string; readonly scheduled: infer TSch }
      ? TSch extends readonly (infer TEntry)[]
        ? TEntry extends { readonly name: infer TName extends string }
          ? { [K in `__${TId}:${TName}`]: unknown }
          : {}
        : {}
      : {}
    : {}
>;

// A plugin declares errors in an `errors: { name: error(...) }` map. The engine
// namespaces each code to `__<id>:<name>`, so the contract's error map keys
// them that way too — that's what a client receives on the wire.
type PluginErrorsFromPlugins<TPlugins> = UnionToIntersection<
  TPlugins extends readonly (infer P)[]
    ? P extends { readonly id: infer TId extends string; readonly errors: infer TErrors }
      ? {
          [K in keyof TErrors as K extends string
            ? `__${TId}:${K}`
            : never]: TErrors[K] extends ErrorDef<string, infer DT> ? DT : unknown;
        }
      : {}
    : {}
>;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

// ---------------------------------------------------------------------------
// Contract — the final type produced by contract()
// ---------------------------------------------------------------------------

type ContractCats<TConfig> = Categorize<DefinitionsFromConfig<TConfig>>;

export interface Contract<TConfig = unknown, TEnv = unknown> {
  readonly __wskit_contract: true;
  readonly __config: TConfig;
  readonly name: string;

  readonly incoming: ContractCats<TConfig>['incoming'];
  readonly outgoing: ContractCats<TConfig>['outgoing'] &
    PluginOutgoingFromPlugins<PluginsFromConfig<TConfig>>;
  readonly requests: ContractCats<TConfig>['requests'];
  readonly streams: ContractCats<TConfig>['streams'];
  readonly resumableStreams: ContractCats<TConfig>['resumableStreams'];
  readonly recordedStreams: ContractCats<TConfig>['recordedStreams'];
  readonly channels: ContractCats<TConfig>['channels'];
  readonly namespaces: ContractCats<TConfig>['namespaces'];
  readonly scheduled: ContractCats<TConfig>['scheduled'] &
    PluginScheduledFromPlugins<PluginsFromConfig<TConfig>>;
  readonly errors: ErrorMapFromConfig<TConfig> &
    PluginErrorsFromPlugins<PluginsFromConfig<TConfig>>;
  readonly features: FeatureFromConfig<TConfig>;
  readonly meta: MetaFromConfig<TConfig>;
  readonly env: TEnv;
  readonly tagGroups: {
    ephemeral: EphemeralTagMapFromConfig<TConfig>;
    persistent: PersistentTagMapFromConfig<TConfig>;
  };

  readonly definitions: DefinitionsFromConfig<TConfig>;
}
