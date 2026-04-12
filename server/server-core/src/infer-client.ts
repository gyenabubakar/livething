/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ErrorDef, ValidationFailed } from '~/errors/errors.ts';
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
 * Convert a union of `ErrorDef` types into a single merged record.
 *
 * For example, given `ErrorDef<'not-found', { id: string }> | ErrorDef<'forbidden', never>`,
 * this produces `{ 'not-found': { id: string }; forbidden: never }`.
 *
 * The distributive conditional (`TDefs extends infer TDef`) ensures each
 * member of the union is processed independently before being merged.
 */
type ErrorMap<TDefs> = SimplifyDeep<
  TDefs extends infer TDef
    ? TDef extends ErrorDef<infer TCode, infer TDetail>
      ? Record<TCode, TDetail>
      : {}
    : never
>;

/** Extract the contract phantom type from a `ServerDefinition`. */
type ContractOf<TServer extends ServerDefinition> =
  TServer extends ServerDefinition<any, infer TContract> ? TContract : ServerContract;

/** The set of error types that wskit always adds to every server's error map. */
type BuiltInErrorUnion = typeof ValidationFailed;

/**
 * Read a wskit `ServerDefinition` and turn it into the full client contract type.
 *
 * Pass the type of your server definition (the value returned by `.done()`)
 * and get back a type that describes every event, request, stream, namespace,
 * channel, and error the server exposes to clients.
 *
 * The client SDK accepts this type as a generic parameter so all client calls
 * are fully type-safe.
 *
 * ```ts
 * // server.ts
 * const myServer = server('chat')
 *   .incoming('send-message', { ... })
 *   .done();
 *
 * export type MyClient = InferClient<typeof myServer>;
 *
 * // client.ts
 * import type { MyClient } from './server';
 * const ws = createClient<MyClient>(...);
 * ws.send('send-message', { text: 'hello' }); // fully typed
 * ```
 *
 * The builder accumulates the contract in its `TState` type parameter and
 * threads it into `ServerDefinition` as a phantom type. `InferClient` reads
 * it directly — there is no fold or tuple traversal at this level.
 */
export type InferClient<TServer extends ServerDefinition> = SimplifyDeep<{
  incoming: ContractOf<TServer>['incoming'];
  outgoing: ContractOf<TServer>['outgoing'];
  requests: ContractOf<TServer>['requests'];
  streams: ContractOf<TServer>['streams'];
  namespaces: ContractOf<TServer>['namespaces'];
  channels: ContractOf<TServer>['channels'];
  /** Built-in engine errors (e.g. `validation-failed`) merged with developer-defined errors. */
  __errors__: ErrorMap<BuiltInErrorUnion> & ContractOf<TServer>['errors'];
}>;
