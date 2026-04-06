/**
 * Generated server metadata registry.
 *
 * `@wskit/server-vite` augments the global `WskitServerRegistry` interface by
 * reading `*.wskit.ts` files and writing `.wskit/*.d.ts` declarations.
 * Bound handler types read from this registry when exact generated context is
 * available.
 */
declare global {
  interface WskitServerRegistry {}
}

export interface ServerRegistry extends WskitServerRegistry {}

export type GeneratedServerContext<TName extends keyof ServerRegistry & string> =
  ServerRegistry[TName] extends { ctx: infer TCtx } ? TCtx : never;

export type GeneratedIncomingContext<
  TName extends keyof ServerRegistry & string,
  TEvent extends string,
> = ServerRegistry[TName] extends {
  incomingContexts: infer TContexts extends Record<string, unknown>;
}
  ? TEvent extends keyof TContexts
    ? TContexts[TEvent]
    : never
  : never;

export type GeneratedRequestContext<
  TName extends keyof ServerRegistry & string,
  TEvent extends string,
> = ServerRegistry[TName] extends {
  requestContexts: infer TContexts extends Record<string, unknown>;
}
  ? TEvent extends keyof TContexts
    ? TContexts[TEvent]
    : never
  : never;

export type GeneratedPostInterceptContext<
  TName extends keyof ServerRegistry & string,
  TEvent extends string,
> = ServerRegistry[TName] extends {
  postInterceptContexts: infer TContexts extends Record<string, unknown>;
}
  ? TEvent extends keyof TContexts
    ? TContexts[TEvent]
    : never
  : never;

export type GeneratedNamespaceContext<
  TName extends keyof ServerRegistry & string,
  TNamespace extends string,
> = ServerRegistry[TName] extends {
  namespaces: infer TNamespaces extends Record<string, unknown>;
}
  ? TNamespace extends keyof TNamespaces
    ? TNamespaces[TNamespace] extends { ctx: infer TCtx }
      ? TCtx
      : never
    : never
  : never;

export type GeneratedChannelContext<
  TName extends keyof ServerRegistry & string,
  TChannel extends string,
> = ServerRegistry[TName] extends {
  channels: infer TChannels extends Record<string, unknown>;
}
  ? TChannel extends keyof TChannels
    ? TChannels[TChannel] extends { ctx: infer TCtx }
      ? TCtx
      : never
    : never
  : never;
