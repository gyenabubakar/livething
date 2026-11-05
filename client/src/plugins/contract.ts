import type {
  BinaryOf,
  ChannelsOf,
  ClientRequestsOf,
  ErrorsOf,
  IncomingOf,
  OutgoingOf,
  ServerRequestsOf,
  SocketContract,
  StreamsOf,
} from '~/types.ts';

/*
 * A plugin owns a namespace. On the wire every one of its names is written as
 * `__<id>::<name>` — the id, two colons, then the plain name. `InferClient`
 * already folds a server plugin's names into the socket contract in exactly this
 * shape, so the client can split them back out from the contract alone. These
 * types do that split at the type level; the runtime does the matching split by
 * string prefix.
 */

/**
 * Keep only the keys of `TMap` that belong to plugin `TId` — the ones written as
 * `__<TId>::<name>` — and drop the `__<TId>::` part, leaving the plain name.
 */
type PickNamespace<TId extends string, TMap> = {
  [K in keyof TMap & string as K extends `__${TId}::${infer Name}` ? Name : never]: TMap[K];
};

/**
 * Drop the keys that belong to a claimed plugin namespace (an id in `TClaimed`),
 * keeping the rest. A prefix nobody claims is left in place, so the app can still
 * reach it directly the way it did before any plugin existed.
 */
type DropClaimed<TMap, TClaimed extends string> = {
  [K in keyof TMap & string as K extends `__${infer TId}::${string}`
    ? TId extends TClaimed
      ? never
      : K
    : K]: TMap[K];
};

/**
 * The contract for one plugin, pulled out of a full socket contract by its `id`.
 * Every section keeps only that plugin's names, with the `__<id>::` prefix removed,
 * so the plugin author works with plain names (`message`, not `__acme:chat::message`).
 *
 * Use it when your server and client share types:
 * `plugin<PluginSlice<InferClient<typeof host>, 'acme:chat'>>({ id: 'acme:chat', ... })`.
 */
export type PluginSlice<TContract extends SocketContract, TId extends string> = {
  incoming: PickNamespace<TId, IncomingOf<TContract>>;
  outgoing: PickNamespace<TId, OutgoingOf<TContract>>;
  clientRequests: PickNamespace<TId, ClientRequestsOf<TContract>>;
  serverRequests: PickNamespace<TId, ServerRequestsOf<TContract>>;
  streams: PickNamespace<TId, StreamsOf<TContract>>;
  channels: PickNamespace<TId, ChannelsOf<TContract>>;
  errors: PickNamespace<TId, ErrorsOf<TContract>>;
} & (TContract extends { binary: infer TBinary }
  ? { binary: { [TSide in keyof TBinary]: PickNamespace<TId, TBinary[TSide]> } }
  : {});

/**
 * A socket contract with the names of every *claimed* plugin removed — the plugin
 * ids in `TClaimed`. This is what the top-level socket is typed against, so once a
 * plugin claims `acme:chat`, `socket.on('__acme:chat::message')` is a type error;
 * those names are reached through the plugin's own API. A prefix no registered
 * plugin claims is left in place, so it stays reachable at the top level. With no plugins
 * (`TClaimed` = `never`) nothing is removed.
 */
export type TopLevelContract<TContract extends SocketContract, TClaimed extends string = never> = {
  incoming: DropClaimed<IncomingOf<TContract>, TClaimed>;
  outgoing: DropClaimed<OutgoingOf<TContract>, TClaimed>;
  clientRequests: DropClaimed<ClientRequestsOf<TContract>, TClaimed>;
  serverRequests: DropClaimed<ServerRequestsOf<TContract>, TClaimed>;
  streams: DropClaimed<StreamsOf<TContract>, TClaimed>;
  channels: DropClaimed<ChannelsOf<TContract>, TClaimed>;
  errors: DropClaimed<ErrorsOf<TContract>, TClaimed>;
  // Always present, `{}` when there is no binary: cheaper to check than a conditional key.
  binary: {
    [TSide in keyof BinaryOf<TContract>]: DropClaimed<BinaryOf<TContract>[TSide], TClaimed>;
  };
};

/** Re-add the `__<TId>::` prefix to every key of `TMap` — the inverse of PickNamespace. */
type PrefixKeys<TId extends string, TMap> = {
  [K in keyof TMap & string as `__${TId}::${K}`]: TMap[K];
};

/**
 * One section of a plugin's requirement: the prefixed map under `TSection`, or
 * nothing when the plugin declares no names there. Omitting empty sections means a
 * plugin only demands the sections it actually uses, so a socket contract missing
 * an unrelated section still satisfies it.
 */
type RequiredSection<TId extends string, TSection extends string, TMap> = keyof TMap extends never
  ? {}
  : { [K in TSection]: PrefixKeys<TId, TMap> };

/**
 * What a registered plugin requires its socket's contract to contain: every one of
 * the plugin's names back under its `__<id>::` wire prefix. `client()` checks the
 * socket contract against this (through each primitive's `_requires`), so
 * registering a plugin onto a contract that doesn't declare its namespace is a
 * type error. A plugin with no contract requires nothing.
 */
export type NamespacedContract<P extends SocketContract, TId extends string> = RequiredSection<
  TId,
  'incoming',
  IncomingOf<P>
> &
  RequiredSection<TId, 'outgoing', OutgoingOf<P>> &
  RequiredSection<TId, 'clientRequests', ClientRequestsOf<P>> &
  RequiredSection<TId, 'serverRequests', ServerRequestsOf<P>> &
  RequiredSection<TId, 'streams', StreamsOf<P>> &
  RequiredSection<TId, 'channels', ChannelsOf<P>> &
  RequiredSection<TId, 'errors', ErrorsOf<P>> &
  ('binary' extends keyof P ? RequiredBinary<TId, P['binary']> : {});

/** The plugin's binary names under its prefix, or nothing when it has none. */
type RequiredBinary<TId extends string, TBinary> = RequiredSection<
  TId,
  'incoming',
  IncomingOf<TBinary>
> &
  RequiredSection<TId, 'outgoing', OutgoingOf<TBinary>> &
  RequiredSection<TId, 'clientRequests', ClientRequestsOf<TBinary>> &
  RequiredSection<TId, 'serverRequests', ServerRequestsOf<TBinary>> &
  RequiredSection<TId, 'streams', StreamsOf<TBinary>> extends infer TSides
  ? keyof TSides extends never
    ? {}
    : { binary: TSides }
  : never;
