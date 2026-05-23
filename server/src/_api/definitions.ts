/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { ChannelDef } from '~/channel/definition.ts';
import type { ErrorContractDef } from '~/errors/definition.ts';
import type { IncomingDef } from '~/incoming/definition.ts';
import type { NamespaceDef } from '~/namespace/definition.ts';
import type { OutgoingDef } from '~/outgoing/definition.ts';
import type { RequestDef } from '~/request/definition.ts';
import type { ScheduledDef } from '~/scheduled/definition.ts';
import type { RecordedStreamDef } from '~/stream-recorded/definition.ts';
import type { ResumableStreamDef } from '~/stream-resumable/definition.ts';
import type { NudgeDef, StreamDef } from '~/stream/definition.ts';

export type {
  ChannelDef,
  ErrorContractDef,
  IncomingDef,
  NamespaceDef,
  NudgeDef,
  OutgoingDef,
  RecordedStreamDef,
  RequestDef,
  ResumableStreamDef,
  ScheduledDef,
  StreamDef,
};

export { channel } from '~/channel/definition.ts';
export { recordedStream } from '~/stream-recorded/definition.ts';
export { resumableStream } from '~/stream-resumable/definition.ts';
export { incoming } from '~/incoming/definition.ts';
export { namespace } from '~/namespace/definition.ts';
export { outgoing } from '~/outgoing/definition.ts';
export { request } from '~/request/definition.ts';
export { scheduled } from '~/scheduled/definition.ts';
export { nudge, stream } from '~/stream/definition.ts';

/**
 * Marker carrying a phantom type so `meta: t<{ username: string }>()` flows the
 * type into the contract without any runtime cost.
 */
export interface TypeMarker<T> {
  readonly __wskit_t: 't';
  readonly _phantom?: T;
}

/**
 * Union of every legal contract-side definition. Order doesn't matter; consumers
 * narrow by the `_` discriminator.
 */
export type Definition =
  | IncomingDef<string, any>
  | OutgoingDef<string, any>
  | RequestDef<string, any, any>
  | StreamDef<string, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | ResumableStreamDef<string, unknown, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | RecordedStreamDef<string, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | ScheduledDef<string, any>
  | ChannelDef<string | ScopeDeclaration<string>, readonly Definition[]>
  | NamespaceDef<string, readonly NamespaceDefinition[]>;

/**
 * The subset of `Definition` allowed inside a `namespace(...)` block.
 * Excludes `ChannelDef` and `NamespaceDef` — channels and namespaces must be
 * declared at the top level of a contract.
 */
export type NamespaceDefinition =
  | IncomingDef<string, any>
  | OutgoingDef<string, any>
  | RequestDef<string, any, any>
  | StreamDef<string, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | ResumableStreamDef<string, unknown, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | RecordedStreamDef<string, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | ScheduledDef<string, any>;

export { error } from '@wskit/core';

/**
 * Type-only carrier used for declaring `meta` shape in contract config.
 *
 * @example
 * ```ts
 * contract<Env>('chat')({
 *   meta: t<{ username: string }>(),
 *   definitions: [...],
 * });
 * ```
 */
export function t<T>(): TypeMarker<T> {
  return { __wskit_t: 't' };
}
