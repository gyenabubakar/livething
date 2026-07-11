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

/** Drop every key that belongs to any plugin (any `__<id>::<name>`), keeping the rest. */
type DropNamespaces<TMap> = {
  [K in keyof TMap & string as K extends `__${string}::${string}` ? never : K]: TMap[K];
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
 * A full socket contract with every plugin-owned name removed. This is what the
 * top-level socket is typed against, so `socket.on('__acme:chat::message')` is a
 * type error — those names belong to their plugin, reached through the plugin's
 * own API, not the socket.
 */
export type TopLevelContract<TContract extends SocketContract> = {
  incoming: DropNamespaces<IncomingOf<TContract>>;
  outgoing: DropNamespaces<OutgoingOf<TContract>>;
  requests: DropNamespaces<RequestsOf<TContract>>;
  serverRequests: DropNamespaces<ServerRequestsOf<TContract>>;
  streams: DropNamespaces<StreamsOf<TContract>>;
  channels: DropNamespaces<ChannelsOf<TContract>>;
  errors: DropNamespaces<ErrorsOf<TContract>>;
};
