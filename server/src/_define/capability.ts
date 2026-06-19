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
 * factory decides the runtime primitives it adds, the contract slots it
 * declares, and the brand of any builder methods it grants `base`.
 *
 * @template TSlots   The client-contract slots this capability declares.
 * @template TFeature The build-time feature flags this capability turns on.
 * @template TBrand   The builder-method group this capability grants `base`
 *   (for example `'requests'` grants `base.request`). `never` for a capability
 *   that grants no method, such as `emits` or `errors`.
 */
export interface Capability<
  TSlots = {},
  TFeature extends string = never,
  TBrand extends string = never,
> extends Contribution<TSlots> {
  readonly __wskitCapability: true;
  /** Runtime primitives this capability contributes to the assembled server. @internal */
  readonly __primitives: readonly Primitive[];
  /** Feature flags this capability turns on, surfaced for build-time checks. @internal */
  readonly __features: readonly TFeature[];
  /**
   * Stable identity token shared with the factory that produced this capability,
   * used to match a plugin's `dependsOn` factory ref to a listed capability
   * without calling the factory. Absent on capabilities that are never a
   * `dependsOn` target (such as plugin capabilities). @internal
   */
  readonly __capabilityKind?: string;
  /** @internal phantom — the builder-method group this capability grants; never set at runtime. */
  readonly __brand?: TBrand;
}

/**
 * Build a capability descriptor from the runtime primitives it contributes.
 *
 * Internal helper used by the capability factories (`emits`, `errors`, and the
 * rest). Product code never calls this — it calls the factories.
 *
 * @internal
 */
export function capability<
  TSlots = {},
  TFeature extends string = never,
  TBrand extends string = never,
  TExtra extends object = {},
>(
  primitives: readonly Primitive[],
  features: readonly TFeature[] = [],
  extra?: TExtra,
): Capability<TSlots, TFeature, TBrand> & TExtra {
  return {
    __wskitCapability: true,
    __primitives: primitives,
    __features: features,
    ...(extra ?? ({} as TExtra)),
  } as Capability<TSlots, TFeature, TBrand> & TExtra;
}

/**
 * Any capability factory — a function that returns a capability, regardless of
 * the arguments it takes. The `dependsOn` matcher reads the identity token off
 * such a ref without ever calling it, so an arg-requiring factory (`keepalive`,
 * `scheduled`, …) is a valid `dependsOn` target. @internal
 */
export type CapabilityFactory = ((...args: any[]) => AnyCapability) & {
  readonly __capabilityKind?: string;
};

/** A capability factory function carrying the identity token its result is stamped with. @internal */
export type KindedFactory<TFactory extends (...args: any[]) => AnyCapability> = TFactory & {
  readonly __capabilityKind: string;
};

/**
 * Stamp a capability factory with a stable identity token and return it. The
 * same token must be applied to every capability the factory produces (via the
 * `kind` argument to `capability()` / `hostCapability()`), so a plugin's
 * `dependsOn` ref can be matched to a listed capability by reading the token off
 * the factory — without ever calling it.
 *
 * @internal
 */
export function withCapabilityKind<TFactory extends (...args: any[]) => AnyCapability>(
  factory: TFactory,
  kind: string,
): KindedFactory<TFactory> {
  return Object.assign(factory, { __capabilityKind: kind });
}

/**
 * A capability the **host** owns and a plugin can never list — the global
 * engines (`dedup`, `sequence`, `keepalive`, `persistence`, `rateLimit`,
 * `replay`). It carries a `__hostOnly` marker so `define({ scoped: true })`
 * rejects it at compile time; a plugin declares a prerequisite on it instead.
 */
export type HostCapability<TSlots = {}, TFeature extends string = never> = Capability<
  TSlots,
  TFeature
> & { readonly __hostOnly: true };

/** Build a host-owned capability — like `capability()`, but marked `__hostOnly`. */
export function hostCapability<TSlots = {}, TFeature extends string = never>(
  primitives: readonly Primitive[],
  features: readonly TFeature[] = [],
): HostCapability<TSlots, TFeature> {
  return capability<TSlots, TFeature, never, { readonly __hostOnly: true }>(primitives, features, {
    __hostOnly: true,
  });
}

/**
 * Stamp a capability instance with its identity token, mirroring the token its
 * factory carries (see {@link withCapabilityKind}). Returns the same instance so
 * factories can `return stampKind(cap, '<kind>')`.
 *
 * @internal
 */
export function stampKind<TCap extends AnyCapability>(cap: TCap, kind: string): TCap {
  (cap as { __capabilityKind: string }).__capabilityKind = kind;
  return cap;
}

/**
 * A capability of any shape. Use this in constraint positions (`extends
 * readonly AnyCapability[]`) — the default `Capability` narrows the brand to
 * `never`, which would reject any capability that grants a builder method.
 */
export type AnyCapability = Capability<any, string, string>;

/** The union of builder-method brands granted across a list of capabilities. @internal */
export type BrandsOf<TCaps extends readonly AnyCapability[]> = NonNullable<
  TCaps[number]['__brand']
>;

/** The union of feature flags turned on across a list of capabilities. @internal */
export type FeaturesOf<TCaps extends readonly AnyCapability[]> =
  TCaps[number]['__features'][number];

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
