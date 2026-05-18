/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  ChannelNotFound,
  ChannelNotSubscribed,
  ErrorDef,
  InternalError,
  NamespaceNotFound,
  ValidationFailed,
} from '~/errors/errors.ts';
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

/** The set of error types that wskit always adds to every server's error map. */
type BuiltInErrorUnion =
  | typeof ValidationFailed
  | typeof ChannelNotFound
  | typeof ChannelNotSubscribed
  | typeof NamespaceNotFound
  | typeof InternalError;

/**
 * Read a wskit `ServerDefinition` and turn it into the full client contract type.
 *
 * Pass the type of your server definition (the value returned by `.build()`)
 * and get back a type that describes every event, request, stream, namespace,
 * channel, and error the server exposes to clients.
 *
 * The client SDK accepts this type as a generic parameter so all client calls
 * are fully type-safe.
 *
 * ```ts
 * import * as v from 'valibot';
 * import { contract, implement, incoming, outgoing } from '@wskit/server';
 *
 * // server.ts
 * const chat = contract<Env>('chat')({
 *   definitions: [
 *     outgoing('chat-message', v.object({ text: v.string() })),
 *     incoming('send-message', v.object({ text: v.string() })),
 *   ],
 * });
 * const myServer = implement(chat)
 *   .on('send-message', (ctx, payload) => ctx.send('chat-message', payload))
 *   .build();
 *
 * export type MyClient = InferClient<typeof myServer>;
 *
 * // client.ts
 * import type { MyClient } from './server';
 * const ws = createClient<MyClient>(...);
 * ws.send('send-message', { text: 'hello' }); // fully typed
 * ```
 *
 * The contract records the outgoing/incoming/request/stream/channel/error
 * shapes. `.build()` carries those onto the `ServerDefinition`. `InferClient`
 * reads them back out and flips them into the client's perspective.
 *
 * `InferClient` simply reads that stored contract back out and turns it into
 * the client type.
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
