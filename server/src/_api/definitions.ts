/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { ChannelDef } from '~/channel/definition.ts';
import type { ErrorContractDef } from '~/errors/definition.ts';
import type { IncomingDef } from '~/incoming/definition.ts';
import type { OutgoingDef } from '~/outgoing/definition.ts';
import type { RequestDef } from '~/request/definition.ts';
import type { CursorStreamDef } from '~/stream-cursor/definition.ts';
import type { RecordedStreamDef } from '~/stream-recorded/definition.ts';
import type { NudgeDef, StreamDef } from '~/stream/definition.ts';

export type {
  ChannelDef,
  ErrorContractDef,
  IncomingDef,
  NudgeDef,
  OutgoingDef,
  RecordedStreamDef,
  RequestDef,
  CursorStreamDef,
  StreamDef,
};

export { channel } from '~/channel/definition.ts';
export { recordedStream } from '~/stream-recorded/definition.ts';
export { cursorStream } from '~/stream-cursor/definition.ts';
export { outgoing } from '~/outgoing/definition.ts';
export { request } from '~/request/definition.ts';
export { nudge, stream } from '~/stream/definition.ts';

/**
 * Marker carrying a phantom type so typed payload and metadata definitions flow
 * into the contract without any runtime cost.
 */
export interface TypeMarker<T> {
  readonly __livething_t: 't';
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
  | CursorStreamDef<string, unknown, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | RecordedStreamDef<string, unknown, unknown, readonly NudgeDef<string, unknown>[]>
  | ChannelDef<string | ScopeDeclaration<string>, readonly Definition[]>;

export { error } from '@livething/core';

/**
 * Type-only carrier used to declare a shape with no runtime schema, such as the
 * payload of an `emits(...)` event.
 *
 * @example
 * ```ts
 * server({ capabilities: [emits({ 'chat-message': t<{ text: string }>() })] });
 * ```
 */
export function t<T>(): TypeMarker<T> {
  return { __livething_t: 't' };
}
