type RegisteredServer<TName extends string> = TName extends keyof WskitServerRegistry
  ? WskitServerRegistry[TName]
  : {};

export type RegisteredOutgoing<TName extends string> =
  RegisteredServer<TName> extends {
    outgoing: infer TOutgoing extends Record<string, unknown>;
  }
    ? TOutgoing
    : {};

export type RegisteredCtx<TName extends string> =
  RegisteredServer<TName> extends {
    ctx: infer TCtx;
  }
    ? TCtx
    : {};

export type HasRegisteredCtx<TName extends string> = keyof RegisteredCtx<TName> extends never
  ? false
  : true;

type RegisteredIncomingContexts<TName extends string> =
  RegisteredServer<TName> extends {
    incomingContexts: infer TContexts extends Record<string, unknown>;
  }
    ? TContexts
    : {};

export type RegisteredIncomingCtx<
  TName extends string,
  TEvent extends string,
> = TEvent extends keyof RegisteredIncomingContexts<TName>
  ? RegisteredIncomingContexts<TName>[TEvent]
  : never;

export type HasRegisteredIncomingCtx<TName extends string, TEvent extends string> = [
  RegisteredIncomingCtx<TName, TEvent>,
] extends [never]
  ? false
  : true;

type RegisteredRequestContexts<TName extends string> =
  RegisteredServer<TName> extends {
    requestContexts: infer TContexts extends Record<string, unknown>;
  }
    ? TContexts
    : {};

export type RegisteredRequestCtx<
  TName extends string,
  TEvent extends string,
> = TEvent extends keyof RegisteredRequestContexts<TName>
  ? RegisteredRequestContexts<TName>[TEvent]
  : never;

export type HasRegisteredRequestCtx<TName extends string, TEvent extends string> = [
  RegisteredRequestCtx<TName, TEvent>,
] extends [never]
  ? false
  : true;

type RegisteredPostInterceptContexts<TName extends string> =
  RegisteredServer<TName> extends {
    postInterceptContexts: infer TContexts extends Record<string, unknown>;
  }
    ? TContexts
    : {};

export type RegisteredPostInterceptCtx<
  TName extends string,
  TEvent extends string,
> = TEvent extends keyof RegisteredPostInterceptContexts<TName>
  ? RegisteredPostInterceptContexts<TName>[TEvent]
  : never;

export type HasRegisteredPostInterceptCtx<TName extends string, TEvent extends string> = [
  RegisteredPostInterceptCtx<TName, TEvent>,
] extends [never]
  ? false
  : true;

type RegisteredNamespaces<TName extends string> =
  RegisteredServer<TName> extends {
    namespaces: infer TNamespaces extends Record<string, unknown>;
  }
    ? TNamespaces
    : {};

export type RegisteredNamespaceCtx<
  TName extends string,
  TNamespace extends string,
> = TNamespace extends keyof RegisteredNamespaces<TName>
  ? RegisteredNamespaces<TName>[TNamespace] extends { ctx: infer TCtx }
    ? TCtx
    : {}
  : {};

export type HasRegisteredNamespaceCtx<
  TName extends string,
  TNamespace extends string,
> = keyof RegisteredNamespaceCtx<TName, TNamespace> extends never ? false : true;

type RegisteredChannels<TName extends string> =
  RegisteredServer<TName> extends {
    channels: infer TChannels extends Record<string, unknown>;
  }
    ? TChannels
    : {};

export type RegisteredChannelCtx<
  TName extends string,
  TChannel extends string,
> = TChannel extends keyof RegisteredChannels<TName>
  ? RegisteredChannels<TName>[TChannel] extends { ctx: infer TCtx }
    ? TCtx
    : {}
  : {};

export type HasRegisteredChannelCtx<
  TName extends string,
  TChannel extends string,
> = keyof RegisteredChannelCtx<TName, TChannel> extends never ? false : true;
