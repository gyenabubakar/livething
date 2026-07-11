import type {
  ChannelsOf,
  ErrorsOf,
  IncomingOf,
  OutgoingOf,
  RequestsOf,
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
  requests: PickNamespace<TId, RequestsOf<TContract>>;
  serverRequests: PickNamespace<TId, ServerRequestsOf<TContract>>;
  streams: PickNamespace<TId, StreamsOf<TContract>>;
  channels: PickNamespace<TId, ChannelsOf<TContract>>;
  errors: PickNamespace<TId, ErrorsOf<TContract>>;
};

/**
 * A socket contract with the names of every *claimed* plugin removed — the plugin
 * ids in `TClaimed`. This is what the top-level socket is typed against, so once a
 * plugin claims `acme:chat`, `socket.on('__acme:chat::message')` is a type error;
 * those names are reached through the plugin's own API. A prefix no registered
 * plugin claims is left in place, so it stays reachable as before. With no plugins
 * (`TClaimed` = `never`) nothing is removed.
 */
export type TopLevelContract<TContract extends SocketContract, TClaimed extends string = never> = {
  incoming: DropClaimed<IncomingOf<TContract>, TClaimed>;
  outgoing: DropClaimed<OutgoingOf<TContract>, TClaimed>;
  requests: DropClaimed<RequestsOf<TContract>, TClaimed>;
  serverRequests: DropClaimed<ServerRequestsOf<TContract>, TClaimed>;
  streams: DropClaimed<StreamsOf<TContract>, TClaimed>;
  channels: DropClaimed<ChannelsOf<TContract>, TClaimed>;
  errors: DropClaimed<ErrorsOf<TContract>, TClaimed>;
};
