/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  ChannelNotFound,
  ChannelNotSubscribed,
  ErrorDef,
  InternalError,
  NudgeOverflow,
  RateLimited,
  RejoinRejected,
  RequestInvalidResponse,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  UnsupportedProtocol,
  ValidationFailed,
} from '~/errors/errors.ts';
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';

/**
 * Recursively expand all intersections and mapped types into their final
 * flat shape. This makes complex inferred types readable in IDE tooltips.
 *
 * Functions are left as-is so their signatures are not destroyed.
 */
type SimplifyDeep<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly unknown[]
    ? { [TIndex in keyof T]: SimplifyDeep<T[TIndex]> }
    : T extends object
      ? { [TKey in keyof T]: SimplifyDeep<T[TKey]> } & {}
      : T;

/**
 * Collapse a union into an intersection.
 *
 * `{ a: 1 } | { b: 2 }` becomes `{ a: 1; b: 2 }` — via contravariance of
 * function argument positions.
 */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/**
 * Convert a union of `ErrorDef` types into a single merged record.
 *
 * For example, given `ErrorDef<'not-found', { id: string }> | ErrorDef<'forbidden', never>`,
 * this produces `{ 'not-found': { id: string }; forbidden: never }`.
 *
 * The distributive conditional (`TDefs extends infer TDef`) ensures each
 * member of the union is processed independently, then `UnionToIntersection`
 * merges the per-member records into one record with every code as a key.
 */
type ErrorMap<TDefs> = SimplifyDeep<
  UnionToIntersection<
    TDefs extends infer TDef
      ? TDef extends ErrorDef<infer TCode, infer TDetail>
        ? Record<TCode, TDetail>
        : {}
      : never
  >
>;

/** Extract the stored client contract type from a `ServerDefinition`. */
type ContractOf<TServer extends ServerDefinition> =
  TServer extends ServerDefinition<any, infer TContract> ? TContract : ServerContract;

/**
 * The set of framework error types WSKit can send to any client, so they are
 * always present in a server's typed error map for `.matches()`. Covers the
 * full set of framework error codes a client can receive.
 */
type BuiltInErrorUnion =
  | typeof ValidationFailed
  | typeof ChannelNotFound
  | typeof ChannelNotSubscribed
  | typeof RejoinRejected
  | typeof InternalError
  | typeof RateLimited
  | typeof RequestInvalidResponse
  | typeof RequestNoCorrelation
  | typeof RequestNoResponse
  | typeof StreamAborted
  | typeof StreamAlreadyActive
  | typeof StreamIdCollision
  | typeof NudgeOverflow
  | typeof UnsupportedProtocol;

/**
 * Read one slot off a contract type, falling back to `{}` when the contract
 * does not declare it. Going through this helper instead of a direct index
 * lets `InferClient` reach slots — like `resumableStreams` — that are not part
 * of the loose `ServerContract` constraint.
 */
type Slot<TContract, TKey extends string> = TKey extends keyof TContract ? TContract[TKey] : {};

/**
 * Drop fields a stream never declared. A stream with no `cursor` validator
 * leaves `cursor` as `unknown`; a stream with no nudges leaves `nudges` as
 * either an open `{ [name: string]: unknown }` map or an empty `{}`. None of
 * these carry information, so the client entry omits them — only streams that
 * declare a real cursor or real nudges keep those fields.
 */
type TidyStreamEntry<TEntry> = Omit<
  TEntry,
  | ('cursor' extends keyof TEntry ? (unknown extends TEntry['cursor'] ? 'cursor' : never) : never)
  | ('nudges' extends keyof TEntry
      ? string extends keyof TEntry['nudges']
        ? 'nudges'
        : keyof TEntry['nudges'] extends never
          ? 'nudges'
          : never
      : never)
>;

/**
 * Map every entry of one server-side stream slot into its client shape:
 * tidied, and stamped with a `kind`. `kind` is `'persistent'` for the durable
 * kinds (`resumableStream` / `recordedStream`) that survive a reconnect, and
 * `'ephemeral'` for a plain `stream`. It mirrors the runtime `__wskit.streamKind`
 * on the wire, and the client reads it to gate resume-only methods at the type level.
 */
type ClientStreamSlot<TSlot, TKind extends 'ephemeral' | 'persistent'> = {
  [TName in keyof TSlot]: TidyStreamEntry<TSlot[TName]> & { kind: TKind };
};

/**
 * The client's flat view of every server-pushed stream. The contract keeps
 * `stream(...)`, `resumableStream(...)`, and `recordedStream(...)` in three
 * separate slots; the client sees one merged map. Undeclared `cursor` /
 * `nudges` fields are omitted, and each entry carries a `kind` discriminator.
 */
type ClientStreams<TContract> = ClientStreamSlot<Slot<TContract, 'streams'>, 'ephemeral'> &
  ClientStreamSlot<Slot<TContract, 'resumableStreams'>, 'persistent'> &
  ClientStreamSlot<Slot<TContract, 'recordedStreams'>, 'persistent'>;

/**
 * One channel turned into the client's perspective: the server's
 * `outgoing` events are what the client receives, its `incoming` events are
 * what the client sends. Channels with a `check` validator also expose a
 * `subscribePayload` field showing what the client must pass when subscribing.
 */
type ClientFamily<TFamily> = {
  incoming: Slot<TFamily, 'outgoing'>;
  outgoing: Slot<TFamily, 'incoming'>;
  requests: Slot<TFamily, 'requests'>;
  serverRequests: Slot<TFamily, 'serverRequests'>;
  streams: ClientStreams<TFamily>;
} & ('subscribePayload' extends keyof TFamily
  ? { subscribePayload: TFamily['subscribePayload'] }
  : {}) &
  (TFamily extends { inbox: true } ? { inbox: true } : {}) &
  (TFamily extends { readReceipts: true } ? { readReceipts: true } : {});

/**
 * Like `ClientFamilyMap`, but channel-aware: each channel family is stamped with
 * an `addressing` discriminator — `'dynamic'` for a dynamic family, `'static'`
 * for a string-pattern channel. The client's `channels` primitive reads it to
 * decide between `channel(name)` and `channel(family, name)` / `channel.family`.
 */
type ClientChannelMap<TChannels> = {
  [TKey in keyof TChannels]: ClientFamily<TChannels[TKey]> & {
    addressing: TChannels[TKey] extends { __addressing: infer A extends 'static' | 'dynamic' }
      ? A
      : 'static';
  };
};

/**
 * Prefix every key of a map with the plugin's wire namespace `__<id>::`. This
 * mirrors what the runtime does on the wire, so a typed client addresses a
 * plugin event by its real name — `socket.on('__id::event')` — just like any
 * other event.
 */
type PrefixKeys<TId extends string, TMap> = {
  [TKey in keyof TMap & string as `__${TId}::${TKey}`]: TMap[TKey];
};

/**
 * One plugin's scoped contract flipped into the client's perspective, with plain
 * names (no `__<id>::` prefix). The plugin's contract is stored in server
 * perspective under `__contract`; each surface is flipped the way the top-level
 * client view flips it (server `outgoing` → client `incoming`, server `incoming`
 * → client `outgoing`). This is the shape a client plugin declares as its own
 * contract, so a plugin author reads it with `InferPluginClient`.
 */
export type ClientPluginContract<TContract> = {
  incoming: Slot<TContract, 'outgoing'>;
  outgoing: Slot<TContract, 'incoming'>;
  requests: Slot<TContract, 'requests'>;
  serverRequests: Slot<TContract, 'serverRequests'>;
  streams: ClientStreams<TContract>;
  channels: ClientChannelMap<Slot<TContract, 'channels'>>;
  errors: Slot<TContract, 'errors'>;
};

/**
 * The same flip as {@link ClientPluginContract}, but with every name carrying the
 * `__<id>::` wire prefix so it can be merged into the top-level client maps. A
 * channel is addressed by its prefixed family name; the channel's inner events
 * stay scoped to that channel and are not prefixed.
 */
type ClientPluginProjection<TId extends string, TContract> = {
  [TSection in keyof ClientPluginContract<TContract>]: PrefixKeys<
    TId,
    ClientPluginContract<TContract>[TSection]
  >;
};

/**
 * Project every registered plugin into a single client-side fragment by folding
 * each plugin's prefixed surfaces together. `TPlugins` maps plugin id →
 * `{ __contract; __api }`; this walks each id, projects its contract under the
 * `__<id>::` prefix, then `UnionToIntersection` merges the per-plugin fragments
 * into one fragment whose maps the top-level `InferClient` intersects with the
 * app's own maps. App names never contain `__id::`, so there is no collision.
 */
type ClientPluginsFragment<TPlugins> = UnionToIntersection<
  {
    [TId in keyof TPlugins & string]: TPlugins[TId] extends { __contract: infer TContract }
      ? ClientPluginProjection<TId, TContract>
      : never;
  }[keyof TPlugins & string]
>;

/** A fragment with every client map empty — the fallback when no plugins are listed. */
type EmptyPluginsFragment = {
  incoming: {};
  outgoing: {};
  requests: {};
  serverRequests: {};
  streams: {};
  channels: {};
  errors: {};
};

/**
 * The merged plugin fragment for a server, or an all-empty fragment when no
 * plugins are listed (`UnionToIntersection<never>` is `unknown`, which would
 * pollute the intersection).
 */
type PluginsFragmentOf<TContract> =
  ClientPluginsFragment<Slot<TContract, 'plugins'>> extends infer TFragment
    ? [keyof Slot<TContract, 'plugins'>] extends [never]
      ? EmptyPluginsFragment
      : TFragment
    : EmptyPluginsFragment;

/**
 * Read a WSKit `ServerDefinition` and turn it into the full client contract type.
 *
 * Pass the type of your server definition (the value returned by `assemble(...)`)
 * and get back a type that describes every event, request, stream, channel,
 * and error the server exposes to clients.
 *
 * The client SDK accepts this type as a generic parameter so all client calls
 * are fully type-safe.
 *
 * ```ts
 * import * as v from 'valibot';
 * import { define, emits, t } from '@wskit/server';
 *
 * // server.ts
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [emits({ 'chat-message': t<{ text: string }>() })],
 * });
 * const handleSend = base.on('send-message', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) {
 *     ctx.send('chat-message', input);
 *   },
 * });
 * export const myServer = base.assemble(handleSend);
 *
 * export type MyClient = InferClient<typeof myServer>;
 *
 * // client.ts
 * import { defineClient, connect } from '@wskit/client';
 * import type { MyClient } from './server';
 * const socket = defineClient<MyClient>(connect('wss://example.com/ws'));
 * socket.connect();
 * socket.send('send-message', { text: 'hello' }); // fully typed
 * ```
 *
 * The assembled definition records all event/request/stream/channel/error
 * shapes. `InferClient` reads them back and flips them into the client's
 * perspective.
 */
export type InferClient<TServer extends ServerDefinition> = InferClientFor<
  ContractOf<TServer>,
  PluginsFragmentOf<ContractOf<TServer>>
>;

/**
 * Build the client view from an app contract and its merged plugin fragment.
 * Every plugin surface is folded into the matching top-level map under its
 * `__<id>::` wire name, so to the client a plugin event is just an event with a
 * prefixed name — `socket.on('__id::event')` / `socket.send('__id::event')` are
 * fully typed. There is no separate `plugins` key on the client.
 */
type InferClientFor<TContract, TPlugins> = SimplifyDeep<{
  /** Events the client receives — server `emits({...})` plus plugin emits under `__id::name`. */
  incoming: Slot<TContract, 'outgoing'> & PluginMapOf<TPlugins, 'incoming'>;
  /** Events the client sends — server `base.on(...)` plus plugin handlers under `__id::name`. */
  outgoing: Slot<TContract, 'incoming'> & PluginMapOf<TPlugins, 'outgoing'>;
  /** Request/response pairs the client can invoke, plus plugin requests under `__id::name`. */
  requests: Slot<TContract, 'requests'> & PluginMapOf<TPlugins, 'requests'>;
  /** Server→client request/response pairs the client answers, plus plugin ones under `__id::name`. */
  serverRequests: Slot<TContract, 'serverRequests'> & PluginMapOf<TPlugins, 'serverRequests'>;
  /**
   * Every server-pushed stream the client can subscribe to. Plain `stream(...)`,
   * `resumableStream(...)`, and `recordedStream(...)` all show up under this
   * single slot, plus plugin streams under `__id::name`. Each entry carries a
   * `kind` — `'persistent'` for the durable kinds that survive a reconnect,
   * `'ephemeral'` for a plain stream — so the client can gate resume-only
   * methods at the type level.
   */
  streams: ClientStreams<TContract> & PluginMapOf<TPlugins, 'streams'>;
  /**
   * Per-channel sub-contracts, each flipped into the client's perspective, plus
   * plugin channels addressed by their `__id::family` prefixed name.
   */
  channels: ClientChannelMap<Slot<TContract, 'channels'>> & PluginMapOf<TPlugins, 'channels'>;
  /**
   * Built-in engine errors (e.g. `validation-failed`) merged with
   * developer-defined errors and plugin errors under `__id::code`.
   */
  errors: ErrorMap<BuiltInErrorUnion> & Slot<TContract, 'errors'> & PluginMapOf<TPlugins, 'errors'>;
}>;

/** Read one map off the merged plugin fragment, falling back to `{}`. */
type PluginMapOf<TPlugins, TKey extends keyof EmptyPluginsFragment> = TKey extends keyof TPlugins
  ? TPlugins[TKey]
  : {};
