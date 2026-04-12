/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';
import type { ErrorDef, ValidationFailed } from '~/errors/errors.ts';

type SimplifyDeep<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly unknown[]
    ? { [TIndex in keyof T]: SimplifyDeep<T[TIndex]> }
    : T extends object
      ? { [TKey in keyof T]: SimplifyDeep<T[TKey]> } & {}
      : T;

type ErrorMap<TDefs> = SimplifyDeep<
  TDefs extends infer TDef
    ? TDef extends ErrorDef<infer TCode, infer TDetail>
      ? Record<TCode, TDetail>
      : {}
    : never
>;

type ContractOf<TServer extends ServerDefinition> =
  TServer extends ServerDefinition<any, infer TContract> ? TContract : ServerContract;

type BuiltInErrorUnion = typeof ValidationFailed;

/**
 * Read a wskit server definition and turn it into the client contract type.
 *
 * The builder accumulates the contract in TState and threads it into
 * ServerDefinition as a phantom type parameter. InferClient reads it
 * directly — no fold, no tuple traversal.
 */
export type InferClient<TServer extends ServerDefinition> = SimplifyDeep<{
  incoming: ContractOf<TServer>['incoming'];
  outgoing: ContractOf<TServer>['outgoing'];
  requests: ContractOf<TServer>['requests'];
  streams: ContractOf<TServer>['streams'];
  namespaces: ContractOf<TServer>['namespaces'];
  channels: ContractOf<TServer>['channels'];
  __errors__: ErrorMap<BuiltInErrorUnion> & ContractOf<TServer>['errors'];
}>;
