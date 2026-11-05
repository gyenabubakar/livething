/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { BinaryEventsCarrier } from '~/_define/app-ctx.ts';
import type {
  ChannelNotFound,
  ChannelNotSubscribed,
  ConnectionBusy,
  CrossInstanceRef,
  DurableStreamRequiresUser,
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
  WrongFrameKind,
} from '~/errors/errors.ts';
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';
import type { Jsonify } from '~/types.ts';

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
 * The set of framework error types LiveThing can send to any client, so they are
 * always present in a server's typed error map for `.matches()`. Covers the
 * full set of framework error codes a client can receive.
 */
type BuiltInErrorUnion =
  | typeof ValidationFailed
  | typeof ChannelNotFound
  | typeof ChannelNotSubscribed
  | typeof CrossInstanceRef
  | typeof DurableStreamRequiresUser
  | typeof RejoinRejected
  | typeof InternalError
  | typeof RateLimited
  | typeof ConnectionBusy
  | typeof RequestInvalidResponse
  | typeof RequestNoCorrelation
  | typeof RequestNoResponse
  | typeof StreamAborted
  | typeof StreamAlreadyActive
  | typeof StreamIdCollision
  | typeof NudgeOverflow
  | typeof UnsupportedProtocol
  | typeof WrongFrameKind;

/**
 * Read one slot off a contract type, falling back to `{}` when the contract
 * does not declare it. Going through this helper instead of a direct index
 * lets `InferClient` reach slots — like `recordedStreams` — that are not part
 * of the loose `ServerContract` constraint.
 */
type Slot<TContract, TKey extends string> = TKey extends keyof TContract ? TContract[TKey] : {};

/**
 * The server's events as the client receives them. The contract keeps the type that `ctx.send`
 * accepts, and the client gets its JSON: what a `toJSON()` returns, if the payload has one.
 */
type ReceivedEvents<TContract> = {
  [K in keyof Slot<TContract, 'outgoing'>]: Jsonify<Slot<TContract, 'outgoing'>[K]>;
};

/**
 * The binary events of one scope (the server, or one channel) in the client's view:
 * `incoming` are the events the client receives, from `binary({ emits })`, with each info
 * as the client gets it; `outgoing` are the events it sends, from `binary.on(...)`. Each
 * entry is the info's type; the bytes are always a `Uint8Array`. Present only when the
 * scope has binary events.
 */
type ClientBinarySlice<TScope> = [
  | keyof Slot<TScope, 'binaryOutgoing'>
  | keyof Slot<TScope, 'binaryIncoming'>
  | keyof Slot<TScope, 'binaryClientRequests'>
  | keyof BinaryServerRequestsOf<TScope>
  | keyof Slot<TScope, 'binaryStreams'>
  | keyof Slot<TScope, 'binaryRecordedStreams'>,
] extends [never]
  ? {}
  : {
      binary: {
        incoming: {
          [K in keyof Slot<TScope, 'binaryOutgoing'>]: Jsonify<Slot<TScope, 'binaryOutgoing'>[K]>;
        };
        outgoing: Slot<TScope, 'binaryIncoming'>;
        /**
         * The binary requests the client sends, from `binary.request(...)`. `payload` is the
         * request's info and `response` the reply's info, as the client gets it.
         */
        clientRequests: ClientBinaryRequests<Slot<TScope, 'binaryClientRequests'>, 'response'>;
        /** The binary requests the server sends, from `binary({ serverRequests })`. */
        serverRequests: ClientBinaryRequests<BinaryServerRequestsOf<TScope>, 'payload'>;
        /**
         * The binary streams, from `binary.stream(...)` and `binary.recordedStream(...)`.
         * `chunk` is each chunk's info.
         */
        streams: [keyof Slot<TScope, 'binaryRecordedStreams'>] extends [never]
          ? ClientStreamSlot<Slot<TScope, 'binaryStreams'>, 'ephemeral'>
          : ClientStreamSlot<Slot<TScope, 'binaryStreams'>, 'ephemeral'> &
              ClientStreamSlot<Slot<TScope, 'binaryRecordedStreams'>, 'persistent'>;
      };
    };

/**
 * The binary requests one side sends, with the info that crosses the wire as the other side
 * gets it: the reply's info for a client request, the request's info for a server request.
 */
type ClientBinaryRequests<TSlot, TJsonSide extends 'payload' | 'response'> = {
  [K in keyof TSlot]: TSlot[K] extends { payload: infer TPayload; response: infer TInfo }
    ? TJsonSide extends 'response'
      ? { payload: TPayload; response: Jsonify<TInfo> }
      : { payload: Jsonify<TPayload>; response: TInfo }
    : TSlot[K];
};

/**
 * The binary server requests of one scope: the root's `binaryServerRequests` slot, or a
 * channel's, which its `serverRequests` map carries under a symbol key.
 */
type BinaryServerRequestsOf<TScope> =
  Slot<TScope, 'serverRequests'> extends BinaryEventsCarrier<infer TRequests>
    ? TRequests
    : Slot<TScope, 'binaryServerRequests'>;

/** The server→client requests, with each payload as the client receives it. */
type ReceivedServerRequests<TContract> = {
  [K in keyof Slot<TContract, 'serverRequests'> & string]: Slot<
    TContract,
    'serverRequests'
  >[K] extends {
    payload: infer TPayload;
  }
    ? Omit<Slot<TContract, 'serverRequests'>[K], 'payload'> & { payload: Jsonify<TPayload> }
    : Slot<TContract, 'serverRequests'>[K];
};

/**
 * Drop fields the client has no use for. A stream with no nudges leaves
 * `nudges` as either an open `{ [name: string]: unknown }` map or an empty
 * `{}`, which carries no information, so only streams that declare real
 * nudges keep that field.
 */
type TidyStreamEntry<TEntry> = Omit<
  TEntry,
  'nudges' extends keyof TEntry
    ? string extends keyof TEntry['nudges']
      ? 'nudges'
      : keyof TEntry['nudges'] extends never
        ? 'nudges'
        : never
    : never
>;

/**
 * Map every entry of one server-side stream slot into its client shape:
 * tidied, and stamped with a `kind`. `kind` is `'persistent'` for a
 * `recordedStream` that survives a reconnect, and
 * `'ephemeral'` for a plain `stream`. It mirrors the runtime `__livething.streamDurability`
 * on the wire, and the client reads it to gate continue-only methods at the type level.
 */
type ClientStreamSlot<TSlot, TKind extends 'ephemeral' | 'persistent'> = {
  [TName in keyof TSlot]: TidyStreamEntry<TSlot[TName]> & { kind: TKind };
};

/**
 * The client's flat view of every server-pushed stream. The contract keeps
 * `stream(...)` and `recordedStream(...)` in two separate slots; the client
 * sees one merged map. Undeclared `nudges` fields are omitted, and each entry
 * carries a `kind` discriminator.
 */
type ClientStreams<TContract> = ClientStreamSlot<Slot<TContract, 'streams'>, 'ephemeral'> &
  ClientStreamSlot<Slot<TContract, 'recordedStreams'>, 'persistent'>;

/**
 * One channel turned into the client's perspective: the server's
 * `outgoing` events are what the client receives, its `incoming` events are
 * what the client sends. Channels with a `check` validator also expose a
 * `subscribePayload` field showing what the client must pass when subscribing.
 */
type ClientFamily<TFamily> = {
  incoming: ReceivedEvents<TFamily>;
  outgoing: Slot<TFamily, 'incoming'>;
  clientRequests: Slot<TFamily, 'clientRequests'>;
  serverRequests: ReceivedServerRequests<TFamily>;
  streams: ClientStreams<TFamily>;
} & ('subscribePayload' extends keyof TFamily
  ? { subscribePayload: TFamily['subscribePayload'] }
  : {}) &
  (TFamily extends { inbox: true } ? { inbox: true } : {}) &
  (TFamily extends { readReceipts: true } ? { readReceipts: true } : {}) &
  ClientBinarySlice<TFamily>;

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
  incoming: ReceivedEvents<TContract>;
  outgoing: Slot<TContract, 'incoming'>;
  clientRequests: Slot<TContract, 'clientRequests'>;
  serverRequests: ReceivedServerRequests<TContract>;
  streams: ClientStreams<TContract>;
  channels: ClientChannelMap<Slot<TContract, 'channels'>>;
  errors: Slot<TContract, 'errors'>;
} & ClientBinarySlice<TContract>;

/** The maps of a `binary` slice. */
type BinarySideName = 'incoming' | 'outgoing' | 'clientRequests' | 'serverRequests' | 'streams';

/** One map of a `binary` slice, or `{}` when there is none. */
type BinarySide<TSlice, TSide extends BinarySideName> = TSlice extends {
  binary: { [K in TSide]: infer TMap };
}
  ? TMap
  : {};

/** A plugin's top-level binary events, requests and streams under their `__<id>::` wire names. */
type PrefixBinary<TId extends string, TContract> =
  ClientBinarySlice<TContract> extends { binary: infer TBinary }
    ? { binary: { [TSide in keyof TBinary]: PrefixKeys<TId, TBinary[TSide]> } }
    : {};

/**
 * The client's top-level `binary` key: the server's own binary events, requests and streams,
 * and every plugin's, under their `__<id>::` names. Absent when there are none.
 */
type ClientBinary<TContract, TPlugins> =
  ClientBinarySlice<TContract> extends infer TOwn
    ? 'binary' extends keyof TOwn | keyof TPlugins
      ? {
          binary: {
            [TSide in BinarySideName]: BinarySide<TOwn, TSide> & BinarySide<TPlugins, TSide>;
          };
        }
      : {}
    : never;

/**
 * The same flip as {@link ClientPluginContract}, but with every name carrying the
 * `__<id>::` wire prefix so it can be merged into the top-level client maps. A
 * channel is addressed by its prefixed family name; the channel's inner events
 * stay scoped to that channel and are not prefixed.
 */
type ClientPluginProjection<TId extends string, TContract> = {
  [TSection in Exclude<keyof ClientPluginContract<TContract>, 'binary'>]: PrefixKeys<
    TId,
    ClientPluginContract<TContract>[TSection]
  >;
} & PrefixBinary<TId, TContract>;

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
  clientRequests: {};
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
 * Read a LiveThing `ServerDefinition` and turn it into the full client contract type.
 *
 * Pass the type of your server definition (the value returned by `assemble(...)`)
 * and get back a type that describes every event, request, stream, channel,
 * and error in the assembled server definition.
 *
 * The client SDK accepts this type as a generic parameter so all client calls
 * are fully type-safe.
 *
 * ```ts
 * import * as v from 'valibot';
 * import { server, emits, t } from '@livething/server';
 *
 * // server.ts
 * const base = server({
 *   capabilities: [emits({ 'chat-message': t<{ text: string }>() })],
 * });
 * const handleSend = base.on('send-message', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) {
 *     ctx.send('chat-message', input);
 *   },
 * });
 * export const myServer = base.assemble({ handlers: [handleSend] });
 *
 * export type MyClient = InferClient<typeof myServer>;
 *
 * // client.ts
 * import { client, connect } from '@livething/client';
 * import type { MyClient } from './server';
 * const socket = client<MyClient>()(connect('wss://example.com/ws'));
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
type InferClientFor<TContract, TPlugins> = SimplifyDeep<
  InferClientMaps<TContract, TPlugins> & ClientBinary<TContract, TPlugins>
>;

type InferClientMaps<TContract, TPlugins> = {
  /** Events the client receives — server `emits({...})` plus plugin emits under `__id::name`. */
  incoming: ReceivedEvents<TContract> & PluginMapOf<TPlugins, 'incoming'>;
  /** Events the client sends — server `base.on(...)` plus plugin handlers under `__id::name`. */
  outgoing: Slot<TContract, 'incoming'> & PluginMapOf<TPlugins, 'outgoing'>;
  /** Request/response pairs the client can invoke, plus plugin requests under `__id::name`. */
  clientRequests: Slot<TContract, 'clientRequests'> & PluginMapOf<TPlugins, 'clientRequests'>;
  /** Server→client request/response pairs the client answers, plus plugin ones under `__id::name`. */
  serverRequests: ReceivedServerRequests<TContract> & PluginMapOf<TPlugins, 'serverRequests'>;
  /**
   * Every server-pushed stream the client can subscribe to. Plain `stream(...)`
   * and `recordedStream(...)` both show up under this single slot, plus plugin
   * streams under `__id::name`. Each entry carries a `kind` — `'persistent'`
   * for a recorded stream that survives a reconnect,
   * `'ephemeral'` for a plain stream — so the client can gate continue-only
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
};

/** Read one map off the merged plugin fragment, falling back to `{}`. */
type PluginMapOf<TPlugins, TKey extends keyof EmptyPluginsFragment> = TKey extends keyof TPlugins
  ? TPlugins[TKey]
  : {};
