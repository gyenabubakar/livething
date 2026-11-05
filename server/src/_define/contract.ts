/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ErrorDef } from '~/errors/errors.ts';
import type { SlotOr, UnionToIntersection } from './capability.ts';

/**
 * The contract built from a server's capabilities and assembled handler values. It is the value
 * carried on the `ServerDefinition` for `InferClient<typeof definition>` to read.
 *
 * Field names follow the **server's** point of view, NOT the client-facing
 * direction of `ServerContract`:
 * `incoming` holds client→server events and `outgoing` holds server→client
 * events. `InferClient` reads this back and flips it into the client's view
 * (its `incoming` is this `outgoing`, and so on), so the generated client types
 * come out correct. Reading these fields directly gives the server direction.
 *
 * Slots not declared by a capability or an assembled handler value collapse to `{}`.
 */
export type BuildContract<TSlots> = {
  /** Client→server events — declared by assembled `base.on(...)` handler values. */
  readonly incoming: AsRecord<SlotOr<TSlots, 'incoming'>>;
  /** Server→client events — declared by the `emits(...)` capability. */
  readonly outgoing: AsRecord<SlotOr<TSlots, 'outgoing'>>;
  /** Client→server request/response pairs — declared by assembled `base.request(...)` values. */
  readonly clientRequests: AsRecord<SlotOr<TSlots, 'clientRequests'>>;
  /** Server→client request/response pairs — declared by `serverRequests({...})`. */
  readonly serverRequests: AsRecord<SlotOr<TSlots, 'serverRequests'>>;
  /** Server-pushed plain streams. */
  readonly streams: AsRecord<SlotOr<TSlots, 'streams'>>;
  /** Server-pushed recorded streams. */
  readonly recordedStreams: AsRecord<SlotOr<TSlots, 'recordedStreams'>>;
  /** Per-channel sub-contracts. */
  readonly channels: AsRecord<SlotOr<TSlots, 'channels'>>;
  /** Named, typed server errors — declared by `errors([...])`. */
  readonly errors: AsRecord<SlotOr<TSlots, 'errors'>>;
  /** Per-plugin contract slices — declared by each `plugin(...)` capability. */
  readonly plugins: AsRecord<SlotOr<TSlots, 'plugins'>>;
  /** Client→server binary events (event → info) — declared by assembled `base.binary.on(...)` values. */
  readonly binaryIncoming: AsRecord<SlotOr<TSlots, 'binaryIncoming'>>;
  /** Server→client binary events (event → info) — declared by `binary({ emits })`. */
  readonly binaryOutgoing: AsRecord<SlotOr<TSlots, 'binaryOutgoing'>>;
};

/** Coerce a slot to a record so the built contract always satisfies `ServerContract`. */
type AsRecord<T> = T extends Record<string, any> ? T : {};

/**
 * Turn a tuple of error definitions into the `{ [code]: detail }` record the
 * client contract stores under `errors`.
 */
export type ErrorSlot<TDefs> = UnionToIntersection<
  TDefs extends readonly (infer TDef)[]
    ? TDef extends ErrorDef<infer TCode extends string, infer TDetail>
      ? { [K in TCode]: TDetail }
      : {}
    : {}
>;

/**
 * The payload type a handler receives, inferred from its `input` schema. A
 * handler with no schema accepts any payload, typed as `unknown`.
 */
export type InferInput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : unknown;
