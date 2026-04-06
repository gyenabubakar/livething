/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ContractFromItems, ErrorsFromItems } from '~/_types/scope-state.ts';
import type { ChannelChild, ChannelPrimitive, ScopeDeclaration } from '~/channel/channel.ts';
import type { ServerDefinition } from '~/define-server.ts';
import type { ErrorDef, ValidationFailed } from '~/errors.ts';
import type { NamespaceChild, NamespacePrimitive } from '~/namespace/namespace.ts';

type AnyChannel = ChannelPrimitive<string | ScopeDeclaration<string>, readonly ChannelChild[]>;
type AnyNamespace = NamespacePrimitive<string, readonly NamespaceChild[]>;

type SimplifyDeep<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly unknown[]
    ? { [TIndex in keyof T]: SimplifyDeep<T[TIndex]> }
    : T extends object
      ? { [TKey in keyof T]: SimplifyDeep<T[TKey]> } & {}
      : T;

type PrimitivesOf<TServer> =
  TServer extends ServerDefinition<infer TPrimitives> ? TPrimitives : never;

type NamespaceContract<TPrimitives extends readonly unknown[]> = SimplifyDeep<
  ContractFromItems<TPrimitives, 'namespace'>
>;

type StaticNamespacesMap<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<
    TPrimitives[number],
    AnyNamespace
  > as TPrimitive extends NamespacePrimitive<infer TPattern, any>
    ? TPattern
    : never]: TPrimitive extends NamespacePrimitive<any, infer TChildren>
    ? NamespaceContract<TChildren>
    : never;
};

type ChannelContract<TPrimitives extends readonly unknown[]> = SimplifyDeep<
  ContractFromItems<TPrimitives, 'channel'>
>;

type StaticChannelsMap<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<TPrimitives[number], AnyChannel> as TPrimitive extends ChannelPrimitive<
    infer TPattern,
    any
  >
    ? TPattern extends string
      ? TPattern
      : never
    : never]: TPrimitive extends ChannelPrimitive<any, infer TChildren>
    ? ChannelContract<TChildren>
    : never;
};

type DynamicChannelsMap<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<TPrimitives[number], AnyChannel> as TPrimitive extends ChannelPrimitive<
    infer TPattern,
    any
  >
    ? TPattern extends ScopeDeclaration<infer TKey>
      ? TKey
      : never
    : never]: TPrimitive extends ChannelPrimitive<any, infer TChildren>
    ? { [name: string]: ChannelContract<TChildren> }
    : never;
};

type DeclaredErrorUnion<TPrimitives extends readonly unknown[]> =
  ErrorsFromItems<TPrimitives>[number];

type ErrorMap<TDefs> = {
  [TDef in TDefs as TDef extends ErrorDef<infer TCode, any> ? TCode : never]: TDef extends ErrorDef<
    string,
    infer TDetail
  >
    ? TDetail
    : never;
};

type BuiltInErrorUnion = typeof ValidationFailed;

/**
 * Read a wskit server definition and turn it into the client contract type.
 *
 * This gives you the plain shape the client sees: top-level events,
 * requests, streams, namespaces, channels, and typed errors.
 */
export type InferClient<TServer extends ServerDefinition> = SimplifyDeep<
  ContractFromItems<PrimitivesOf<TServer>, 'top'> & {
    namespaces: StaticNamespacesMap<PrimitivesOf<TServer>>;
    channels: StaticChannelsMap<PrimitivesOf<TServer>> & DynamicChannelsMap<PrimitivesOf<TServer>>;
    __errors__: ErrorMap<DeclaredErrorUnion<PrimitivesOf<TServer>> | BuiltInErrorUnion>;
  }
>;
