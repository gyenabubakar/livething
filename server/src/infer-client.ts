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

/** The set of error types that WSKit always adds to every server's error map. */
type BuiltInErrorUnion =
  | typeof ValidationFailed
  | typeof ChannelNotFound
  | typeof ChannelNotSubscribed
  | typeof NamespaceNotFound
  | typeof InternalError;

/**
 * Read one slot off a contract type, falling back to `{}` when the contract
 * does not declare it. Going through this helper instead of a direct index
 * lets `InferClient` reach slots — like `resumableStreams` — that are not part
 * of the loose `ServerContract` constraint.
 */
type Slot<TContract, TKey extends string> = TKey extends keyof TContract ? TContract[TKey] : {};

/**
 * Drop fields a stream never declared. A stream with no `cursor` validator
 * leaves `cursor` as `unknown`; a stream with no nudges leaves `nudges` as an
 * open `{ [name: string]: unknown }` map. Neither carries information, so the
 * client entry omits them — only streams that declare a real cursor or real
 * nudges keep those fields.
 */
type TidyStreamEntry<TEntry> = Omit<
  TEntry,
  | ('cursor' extends keyof TEntry ? (unknown extends TEntry['cursor'] ? 'cursor' : never) : never)
  | ('nudges' extends keyof TEntry
      ? string extends keyof TEntry['nudges']
        ? 'nudges'
        : never
      : never)
>;

/**
 * Map every entry of one server-side stream slot into its client shape:
 * tidied, and stamped with a `kind`. `kind` is `'persistent'` for the durable
 * kinds (`resumableStream` / `recordedStream`) that survive a reconnect, and
 * `'ephemeral'` for a plain `stream`. It mirrors the runtime `__wskit.streamKind`
 * on the wire, and the client reads it to gate resume-only methods at the type level.
 */
type ClientStreamSlot<TSlot, TKind extends 'ephemeral' | 'persistent'> = {
  [TName in keyof TSlot]: TidyStreamEntry<TSlot[TName]> & { kind: TKind };
};

/**
 * The client's flat view of every server-pushed stream. The contract keeps
 * `stream(...)`, `resumableStream(...)`, and `recordedStream(...)` in three
 * separate slots; the client sees one merged map. Undeclared `cursor` /
 * `nudges` fields are omitted, and each entry carries a `kind` discriminator.
 */
type ClientStreams<TContract> = ClientStreamSlot<Slot<TContract, 'streams'>, 'ephemeral'> &
  ClientStreamSlot<Slot<TContract, 'resumableStreams'>, 'persistent'> &
  ClientStreamSlot<Slot<TContract, 'recordedStreams'>, 'persistent'>;

/**
 * One channel or namespace turned into the client's perspective: the server's
 * `outgoing` events are what the client receives, its `incoming` events are
 * what the client sends. Channels with a `check` validator also expose a
 * `subscribePayload` field showing what the client must pass when subscribing.
 */
type ClientScope<TScope> = {
  incoming: Slot<TScope, 'outgoing'>;
  outgoing: Slot<TScope, 'incoming'>;
  requests: Slot<TScope, 'requests'>;
  streams: ClientStreams<TScope>;
} & ('subscribePayload' extends keyof TScope
  ? { subscribePayload: TScope['subscribePayload'] }
  : {});

/** Apply `ClientScope` to every entry of a channel or namespace map. */
type ClientScopeMap<TScopes> = { [TKey in keyof TScopes]: ClientScope<TScopes[TKey]> };

/**
 * Like `ClientScopeMap`, but channel-aware: each channel scope is stamped with
 * an `addressing` discriminator — `'dynamic'` for a `scope()` family, `'fixed'`
 * for a string-pattern channel. The client's `channels` primitive reads it to
 * decide between `channel(name)` and `channel(scope, name)` / `channel.scope`.
 */
type ClientChannelMap<TChannels> = {
  [TKey in keyof TChannels]: ClientScope<TChannels[TKey]> & {
    addressing: TChannels[TKey] extends { __addressing: infer A extends 'fixed' | 'dynamic' }
      ? A
      : 'fixed';
  };
};

/**
 * Read a WSKit `ServerDefinition` and turn it into the full client contract type.
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
 * import { contract, implement, incoming, outgoing, t } from '@wskit/server';
 *
 * // server.ts
 * const chat = contract('chat', { env: t<Env>(),
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
 * import { defineClient, connect } from '@wskit/client';
 * import type { MyClient } from './server';
 * const socket = defineClient<MyClient>(connect('wss://example.com/ws'));
 * socket.connect();
 * socket.send('send-message', { text: 'hello' }); // fully typed
 * ```
 *
 * The contract records all event/request/stream/channel/error shapes.
 * `.build()` stores them on the `ServerDefinition`. `InferClient` reads
 * them back and flips them into the client's perspective.
 */
export type InferClient<TServer extends ServerDefinition> = SimplifyDeep<{
  /** Events the client receives — declared on the server with `outgoing(...)`. */
  incoming: Slot<ContractOf<TServer>, 'outgoing'>;
  /** Events the client sends — declared on the server with `incoming(...)`. */
  outgoing: Slot<ContractOf<TServer>, 'incoming'>;
  /** Request/response pairs the client can invoke — declared with `request(...)`. */
  requests: Slot<ContractOf<TServer>, 'requests'>;
  /**
   * Every server-pushed stream the client can subscribe to. Plain `stream(...)`,
   * `resumableStream(...)`, and `recordedStream(...)` all show up under this
   * single slot. Each entry carries a `kind` — `'persistent'` for the durable
   * kinds that survive a reconnect, `'ephemeral'` for a plain stream — so the
   * client can gate resume-only methods at the type level.
   */
  streams: ClientStreams<ContractOf<TServer>>;
  /** Per-namespace sub-contracts, each flipped into the client's perspective. */
  namespaces: ClientScopeMap<Slot<ContractOf<TServer>, 'namespaces'>>;
  /** Per-channel sub-contracts, each flipped into the client's perspective. */
  channels: ClientChannelMap<Slot<ContractOf<TServer>, 'channels'>>;
  /** Built-in engine errors (e.g. `validation-failed`) merged with developer-defined errors. */
  errors: ErrorMap<BuiltInErrorUnion> & Slot<ContractOf<TServer>, 'errors'>;
}>;
