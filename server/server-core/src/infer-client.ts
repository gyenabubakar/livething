/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ContractFromItems, ErrorsFromItems, MergeRecords } from '~/_types/scope-state.ts';
import type { ChannelChild, ChannelPrimitive, ScopeDeclaration } from '~/channel/channel.ts';
import type { ErrorDef, ValidationFailed } from '~/errors/errors.ts';
import type { ModuleInstance } from '~/modules/define.ts';
import type { NamespaceChild, NamespacePrimitive } from '~/namespace/namespace.ts';
import type { OutgoingPrimitive } from '~/outgoing/index.ts';
import type { ServerDefinition } from '~/server-definition.ts';

type AnyChannel = ChannelPrimitive<string | ScopeDeclaration<string>, readonly ChannelChild[]>;
type AnyNamespace = NamespacePrimitive<string, readonly NamespaceChild[]>;
type AnyErrorDef = ErrorDef<string, any>;
type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyModule = ModuleInstance<string, any, any, readonly AnyOutgoing[], readonly AnyErrorDef[]>;
type UnionToIntersection<T> = (T extends any ? (arg: T) => void : never) extends (
  arg: infer TIntersection,
) => void
  ? TIntersection
  : never;

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

type ModuleOutgoingEntry<TModule extends AnyModule> = {
  [TPrimitive in TModule['outgoing'][number] as TPrimitive extends OutgoingPrimitive<
    infer TEvent,
    any
  >
    ? `__${TModule['id']}:${TEvent}`
    : never]: TPrimitive extends OutgoingPrimitive<string, infer TPayload> ? TPayload : never;
};

type MergeModuleOutgoingEntries<TModules> = TModules extends infer TModule
  ? TModule extends AnyModule
    ? ModuleOutgoingEntry<TModule>
    : {}
  : {};

type ModuleOutgoingMap<TPrimitives extends readonly unknown[]> = SimplifyDeep<
  [Extract<TPrimitives[number], AnyModule>] extends [never]
    ? {}
    : UnionToIntersection<MergeModuleOutgoingEntries<Extract<TPrimitives[number], AnyModule>>>
>;

type DeclaredErrorUnion<TPrimitives extends readonly unknown[]> =
  ErrorsFromItems<TPrimitives>[number];

type ModuleErrorsMap<TPrimitives extends readonly unknown[]> = SimplifyDeep<
  [Extract<TPrimitives[number], AnyModule>] extends [never]
    ? {}
    : UnionToIntersection<
        Extract<TPrimitives[number], AnyModule> extends infer TModule
          ? TModule extends ModuleInstance<
              string,
              any,
              any,
              any,
              infer TErrors extends readonly AnyErrorDef[]
            >
            ? {
                [TDef in TErrors[number] as TDef extends ErrorDef<infer TCode, any>
                  ? `__${TModule['id']}:${TCode}`
                  : never]: TDef extends ErrorDef<string, infer TDetail> ? TDetail : never;
              }
            : {}
          : {}
      >
>;

type ErrorMap<TDefs> = SimplifyDeep<
  UnionToIntersection<
    TDefs extends infer TDef
      ? TDef extends ErrorDef<infer TCode, infer TDetail>
        ? Record<TCode, TDetail>
        : {}
      : never
  >
>;

type BuiltInErrorUnion = typeof ValidationFailed;

/**
 * Read a wskit server definition and turn it into the client contract type.
 *
 * This gives you the plain shape the client sees: top-level events,
 * requests, streams, namespaces, channels, and typed errors.
 */
export type InferClient<TServer extends ServerDefinition> = SimplifyDeep<
  ContractFromItems<PrimitivesOf<TServer>, 'top'> & {
    incoming: MergeRecords<
      ContractFromItems<PrimitivesOf<TServer>, 'top'>['incoming'],
      ModuleOutgoingMap<PrimitivesOf<TServer>>
    >;
    namespaces: StaticNamespacesMap<PrimitivesOf<TServer>>;
    channels: StaticChannelsMap<PrimitivesOf<TServer>> & DynamicChannelsMap<PrimitivesOf<TServer>>;
    __errors__: ErrorMap<DeclaredErrorUnion<PrimitivesOf<TServer>> | BuiltInErrorUnion> &
      ModuleErrorsMap<PrimitivesOf<TServer>>;
  }
>;
