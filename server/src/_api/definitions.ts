/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Plain-data definition objects produced by the contract factories
 * (`incoming(...)`, `outgoing(...)`, `channel(...)`, etc.). Each one captures
 * everything the contract needs to know at declaration time — never a handler.
 *
 * `implement(contract)` later pairs handlers to these by name.
 */

// ---------------------------------------------------------------------------
// Reserved name helpers
// ---------------------------------------------------------------------------

import { RESERVED_EVENT_NAMES } from '~/_engine/compile/utils.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { Validator } from '~/types.ts';

// ---------------------------------------------------------------------------
// Definition kinds
// ---------------------------------------------------------------------------

export interface IncomingDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'incoming';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

export interface OutgoingDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'outgoing';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

export interface RequestDef<
  TName extends string = string,
  TPayload = unknown,
  TResponse = unknown,
> {
  readonly _: 'request';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly response?: Validator<TResponse>;
}

export interface NudgeDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'nudge';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

export interface StreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> {
  readonly _: 'stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: Validator<TChunk>;
  readonly nudges: TNudges;
  readonly broadcast: boolean;
  readonly allowConcurrent: boolean;
}

export interface ScheduledDef<TId extends string = string, TData = unknown> {
  readonly _: 'scheduled';
  readonly id: TId;
  readonly data?: Validator<TData>;
  readonly retry?: boolean | readonly number[];
  readonly every?: number;
}

export interface ChannelDef<
  TPattern extends string | ScopeDeclaration<string> = string | ScopeDeclaration<string>,
  TDefinitions extends readonly Definition[] = readonly Definition[],
> {
  readonly _: 'channel';
  readonly pattern: TPattern;
  readonly persistent?: boolean;
  readonly replay?: unknown;
  readonly definitions: TDefinitions;
}

export interface NamespaceDef<
  TName extends string = string,
  TDefinitions extends readonly Definition[] = readonly Definition[],
> {
  readonly _: 'namespace';
  readonly name: TName;
  readonly definitions: TDefinitions;
}

export interface ErrorContractDef<TCode extends string = string, TDetail = unknown> {
  readonly _: 'error';
  readonly code: TCode;
  readonly schema?: Validator<TDetail>;
}

/**
 * Marker carrying a phantom type so `meta: t<{ username: string }>()` flows the
 * type into the contract without any runtime cost.
 */
export interface TypeMarker<T> {
  readonly __wskit_t: 't';
  readonly _phantom?: T;
}

export type Definition =
  | IncomingDef<string, any>
  | OutgoingDef<string, any>
  | RequestDef<string, any, any>
  | StreamDef<string, any, any, readonly NudgeDef<string, any>[]>
  | ScheduledDef<string, any>
  | ChannelDef<string | ScopeDeclaration<string>, readonly Definition[]>
  | NamespaceDef<string, readonly Definition[]>;

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Declare a client→server event with an optional schema. Use it in a contract's
 * `definitions` array; bind the handler later via `implement(contract).on(name, ...)`.
 *
 * @example
 * ```ts
 * import { contract, incoming, implement } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const c = contract('chat', {
 *   definitions: [incoming('send-msg', v.object({ text: v.string() }))],
 * });
 *
 * implement(c).on('send-msg', (ctx, payload) => { ... });
 * ```
 */
export function incoming<TName extends string>(name: TName): IncomingDef<TName, unknown>;
export function incoming<TName extends string, TPayload>(
  name: TName,
  schema: (value: unknown) => TPayload,
): IncomingDef<TName, TPayload>;
export function incoming<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): IncomingDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function incoming<TName extends string, TPayload>(
  name: TName,
  schema: Validator<TPayload>,
): IncomingDef<TName, TPayload>;
export function incoming(name: string, schema?: Validator): IncomingDef {
  assertNonReservedEventName(name, 'incoming');
  return { _: 'incoming', name, schema };
}

/**
 * Declare a server→client event with an optional schema. The event name and
 * payload type flow into `InferClient` so the generated client SDK is typed.
 */
export function outgoing<TName extends string>(name: TName): OutgoingDef<TName, unknown>;
export function outgoing<TName extends string, TPayload>(
  name: TName,
  schema: (value: unknown) => TPayload,
): OutgoingDef<TName, TPayload>;
export function outgoing<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): OutgoingDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function outgoing<TName extends string, TPayload>(
  name: TName,
  schema: Validator<TPayload>,
): OutgoingDef<TName, TPayload>;
export function outgoing(name: string, schema?: Validator): OutgoingDef {
  assertNonReservedEventName(name, 'outgoing');
  return { _: 'outgoing', name, schema };
}

/**
 * Declare a request/response pair. The handler returns or calls `ctx.respond()`
 * with a value matching the declared response schema.
 */
export function request<TName extends string, TPayload = unknown, TResponse = unknown>(
  name: TName,
  config?: { payload?: Validator<TPayload>; response?: Validator<TResponse> },
): RequestDef<TName, TPayload, TResponse> {
  assertNonReservedEventName(name, 'request');
  return { _: 'request', name, payload: config?.payload, response: config?.response };
}

/**
 * Declare a single nudge — a client→server signal that flows into an active
 * stream as the value of `yield`. Use inside a `stream(...)` definition.
 */
export function nudge<TName extends string>(name: TName): NudgeDef<TName, unknown>;
export function nudge<TName extends string, TPayload>(
  name: TName,
  schema: (value: unknown) => TPayload,
): NudgeDef<TName, TPayload>;
export function nudge<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): NudgeDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function nudge(name: string, schema?: Validator): NudgeDef {
  return { _: 'nudge', name, schema };
}

/**
 * Declare a server-pushed stream. The generator is attached later via
 * `implement(contract).stream(name, async function* (ctx, payload) { ... })`.
 */
export function stream<
  TName extends string,
  TPayload = unknown,
  TChunk = unknown,
  const TNudges extends readonly NudgeDef<string, any>[] = readonly [],
>(
  name: TName,
  config?: {
    payload?: Validator<TPayload>;
    chunk?: Validator<TChunk>;
    nudges?: TNudges;
    broadcast?: boolean;
    allowConcurrent?: boolean;
  },
): StreamDef<TName, TPayload, TChunk, TNudges> {
  assertNonReservedEventName(name, 'stream');
  return {
    _: 'stream',
    name,
    payload: config?.payload,
    chunk: config?.chunk,
    nudges: (config?.nudges ?? []) as TNudges,
    broadcast: config?.broadcast ?? false,
    allowConcurrent: config?.allowConcurrent ?? false,
  };
}

/**
 * Declare a scheduled task. Bind its body via
 * `implement(contract).scheduled(id, (ctx, data) => { ... })`.
 */
export function scheduled<TId extends string, TData = unknown>(
  id: TId,
  config?: {
    data?: Validator<TData>;
    retry?: boolean | readonly number[];
    every?: number;
  },
): ScheduledDef<TId, TData> {
  return {
    _: 'scheduled',
    id,
    data: config?.data,
    retry: config?.retry,
    every: config?.every,
  };
}

/**
 * Declare a channel — a pub/sub group with its own incoming/outgoing events.
 * Use a string for static channels or `scope()` for dynamic patterns.
 */
export function channel<TPattern extends string, const TDefinitions extends readonly Definition[]>(
  pattern: TPattern,
  config: { persistent?: boolean; replay?: unknown; definitions: TDefinitions },
): ChannelDef<TPattern, TDefinitions>;
export function channel<TKey extends string, const TDefinitions extends readonly Definition[]>(
  pattern: ScopeDeclaration<TKey>,
  config: { persistent?: boolean; replay?: unknown; definitions: TDefinitions },
): ChannelDef<ScopeDeclaration<TKey>, TDefinitions>;
export function channel(
  pattern: string | ScopeDeclaration<string>,
  config: { persistent?: boolean; replay?: unknown; definitions: readonly Definition[] },
): ChannelDef {
  return {
    _: 'channel',
    pattern,
    persistent: config.persistent,
    replay: config.replay,
    definitions: config.definitions,
  };
}

/**
 * Declare a namespace — a grouping of events under a shared prefix.
 */
export function namespace<TName extends string, const TDefinitions extends readonly Definition[]>(
  name: TName,
  config: { definitions: TDefinitions },
): NamespaceDef<TName, TDefinitions> {
  return { _: 'namespace', name, definitions: config.definitions };
}

// Re-export the runtime error factory from core. It returns an `ErrorDefWithFactory`
// that is callable (e.g. `throw NotFound({ id: 'x' })`) and can be passed into
// the `errors: [...]` array on the contract config. We treat it as both an error
// declaration and a throwable.
export { error } from '@wskit/core';

/**
 * Type-only carrier used for declaring `meta` shape in contract config.
 *
 * @example
 * ```ts
 * contract<Env>('chat', {
 *   meta: t<{ username: string }>(),
 *   definitions: [...],
 * })
 * ```
 */
export function t<T>(): TypeMarker<T> {
  return { __wskit_t: 't' };
}

function assertNonReservedEventName(name: string, factory: string): void {
  if (RESERVED_EVENT_NAMES.has(name)) {
    throw new Error(
      `[wskit] '${name}' is a reserved protocol event name. Pick a different name for ${factory}().`,
    );
  }
  if (name.startsWith('__')) {
    throw new Error(
      `[wskit] '${name}' starts with the reserved double-underscore prefix. That prefix is reserved for module-owned events.`,
    );
  }
  if (name.startsWith('_')) {
    throw new Error(
      `[wskit] '${name}' starts with the reserved single-underscore prefix. That prefix is reserved for engine protocol events.`,
    );
  }
}
