/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Derives the structured `Contract` shape from a tuple of `Definition` items.
 * Each section (`incoming`, `outgoing`, `requests`, `streams`, `scheduled`,
 * `channels`, `namespaces`) is a record keyed by definition name.
 *
 * `use(group)` flattens the group's contract into this one. Groups are themselves
 * `Contract`-shaped, so the merge is a straight intersection.
 */

import type { ScopeDeclaration } from '~/channel/channel.ts';
import type {
  ChannelDef,
  Definition,
  IncomingDef,
  NamespaceDef,
  NudgeDef,
  OutgoingDef,
  RequestDef,
  ScheduledDef,
  StreamDef,
  TypeMarker,
  UseDef,
} from './definitions.ts';

// ---------------------------------------------------------------------------
// Per-definition contract slot extractors
// ---------------------------------------------------------------------------

type MergeUnion<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;

type ExtractIncoming<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends IncomingDef<infer N, infer P>
      ? Record<N, P>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer C>
          ? C extends { incoming: infer I }
            ? I
            : {}
          : {}
        : {};
  }[number]
>;

type ExtractOutgoing<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends OutgoingDef<infer N, infer P>
      ? Record<N, P>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer C>
          ? C extends { outgoing: infer O }
            ? O
            : {}
          : {}
        : {};
  }[number]
>;

type ExtractRequests<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends RequestDef<infer N, infer P, infer R>
      ? Record<N, { payload: P; response: R }>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer C>
          ? C extends { requests: infer Req }
            ? Req
            : {}
          : {}
        : {};
  }[number]
>;

type NudgesMap<TNudges extends readonly NudgeDef<string, any>[]> = MergeUnion<
  {
    [K in keyof TNudges]: TNudges[K] extends NudgeDef<infer N, infer P> ? Record<N, P> : never;
  }[number]
>;

type ExtractStreams<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends StreamDef<infer N, infer P, infer C, infer Nu>
      ? Record<N, { payload: P; chunk: C; nudges: NudgesMap<Nu>; broadcast: boolean }>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer Ctr>
          ? Ctr extends { streams: infer S }
            ? S
            : {}
          : {}
        : {};
  }[number]
>;

type ExtractScheduled<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends ScheduledDef<infer I, infer D>
      ? Record<I, D>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer C>
          ? C extends { scheduled: infer S }
            ? S
            : {}
          : {}
        : {};
  }[number]
>;

type ChannelKeyFromPattern<P> = P extends string
  ? P
  : P extends ScopeDeclaration<infer K>
    ? K
    : never;

type ExtractChannels<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends ChannelDef<infer Pat, infer Defs>
      ? Record<ChannelKeyFromPattern<Pat>, ChannelContract<Defs>>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer C>
          ? C extends { channels: infer Ch }
            ? Ch
            : {}
          : {}
        : {};
  }[number]
>;

type ExtractNamespaces<TDefs extends readonly Definition[]> = MergeUnion<
  {
    [K in keyof TDefs]: TDefs[K] extends NamespaceDef<infer N, infer Defs>
      ? Record<N, NamespaceContract<Defs>>
      : TDefs[K] extends UseDef<infer G>
        ? G extends Group<infer C>
          ? C extends { namespaces: infer Ns }
            ? Ns
            : {}
          : {}
        : {};
  }[number]
>;

// ---------------------------------------------------------------------------
// Sub-contracts
// ---------------------------------------------------------------------------

export interface ChannelContract<TDefs extends readonly Definition[] = readonly Definition[]> {
  readonly incoming: ExtractIncoming<TDefs>;
  readonly outgoing: ExtractOutgoing<TDefs>;
  readonly requests: ExtractRequests<TDefs>;
  readonly streams: ExtractStreams<TDefs>;
}

export interface NamespaceContract<TDefs extends readonly Definition[] = readonly Definition[]> {
  readonly incoming: ExtractIncoming<TDefs>;
  readonly outgoing: ExtractOutgoing<TDefs>;
  readonly requests: ExtractRequests<TDefs>;
  readonly streams: ExtractStreams<TDefs>;
  readonly channels: ExtractChannels<TDefs>;
}

// ---------------------------------------------------------------------------
// Group shape
// ---------------------------------------------------------------------------

export interface Group<TContract = unknown> {
  readonly __wskit_group: true;
  readonly contract: TContract;
  readonly registrations: unknown;
}

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

export interface Contract<TConfig = unknown, TEnv = unknown> {
  readonly __wskit_contract: true;
  readonly __config: TConfig;
  readonly name: string;

  readonly incoming: ExtractIncoming<DefinitionsFromConfig<TConfig>>;
  readonly outgoing: ExtractOutgoing<DefinitionsFromConfig<TConfig>>;
  readonly requests: ExtractRequests<DefinitionsFromConfig<TConfig>>;
  readonly streams: ExtractStreams<DefinitionsFromConfig<TConfig>>;
  readonly channels: ExtractChannels<DefinitionsFromConfig<TConfig>>;
  readonly namespaces: ExtractNamespaces<DefinitionsFromConfig<TConfig>>;
  readonly scheduled: ExtractScheduled<DefinitionsFromConfig<TConfig>>;
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
