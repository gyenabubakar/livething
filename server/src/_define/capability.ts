/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * Phantom carrier that tells `define()` and `base.assemble()` which slots of
 * the client contract a value contributes.
 *
 * Both capabilities (the things you list in `capabilities`) and handlers (the
 * things you pass to `assemble`) carry one. The `__contributes` field is never
 * present at runtime — only its type is read, to build the client contract that
 * `InferClient` reads back.
 *
 * The slot keys mirror the client contract: `incoming`, `outgoing`, `requests`,
 * `streams`, `resumableStreams`, `recordedStreams`, `channels`, `scheduled`,
 * `errors`, plus `ephemeralTags` / `persistentTags` for tag groups.
 */
export interface Contribution<TSlots = {}> {
  /** @internal phantom — the contract slots this value adds; never set at runtime. */
  readonly __contributes?: TSlots;
}

/**
 * A capability is an opt-in feature you list in
 * `define({ capabilities: [...] })`. Listing one is what pulls its engine code
 * into the bundle, so a server only ships the features it actually uses.
 *
 * You never build a capability by hand — call a capability factory such as
 * `emits(...)` or `errors(...)` and place the result in `capabilities`. Each
 * factory decides the runtime primitives it adds, the builder methods it grants
 * `base`, and the contract slots it declares.
 *
 * @template TSlots   The client-contract slots this capability declares.
 * @template TMethods The builder methods this capability adds to `base`.
 * @template TFeature The build-time feature flags this capability turns on.
 */
export interface Capability<
  TSlots = {},
  TMethods = {},
  TFeature extends string = never,
> extends Contribution<TSlots> {
  readonly __wskitCapability: true;
  /** Runtime primitives this capability contributes to the assembled server. @internal */
  readonly __primitives: readonly Primitive[];
  /** @internal phantom — builder methods this capability adds to `base`; never set at runtime. */
  readonly __methods?: TMethods;
  /** Feature flags this capability turns on, surfaced for build-time checks. @internal */
  readonly __features: readonly TFeature[];
}

/**
 * Build a capability descriptor from the runtime primitives it contributes.
 *
 * Internal helper used by the capability factories (`emits`, `errors`, and the
 * rest). Product code never calls this — it calls the factories.
 *
 * @internal
 */
export function capability<TSlots = {}, TMethods = {}, TFeature extends string = never>(
  primitives: readonly Primitive[],
  features: readonly TFeature[] = [],
): Capability<TSlots, TMethods, TFeature> {
  return {
    __wskitCapability: true,
    __primitives: primitives,
    __features: features,
  } as Capability<TSlots, TMethods, TFeature>;
}

/** Collapse a union of slot records into one merged record. @internal */
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** The slot record a contribution declares, or `{}` when it declares none. @internal */
export type SlotsOf<T> = T extends Contribution<infer S> ? S : {};

/** Merge a union of slot records into one combined slot record. @internal */
export type MergeSlots<TUnion> = UnionToIntersection<TUnion>;

/** Read one slot off a merged slot record, falling back to `{}`. @internal */
export type SlotOr<TSlots, TKey extends string> = TKey extends keyof TSlots ? TSlots[TKey] : {};
