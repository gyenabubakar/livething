import { capabilityDisplayName, HOST_ONLY_CAPABILITY_KINDS } from '~/_define/capability-kinds.ts';
import type { AnyCapability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';

/** A channel primitive nests its own primitives; a durable stream can live there. */
function nestedPrimitives(primitive: Primitive): readonly Primitive[] {
  return (primitive as { primitives?: readonly Primitive[] }).primitives ?? [];
}

/** Walk top-level and channel-nested primitives, calling `visit` on each. */
function walkPrimitives(primitives: readonly Primitive[], visit: (p: Primitive) => void): void {
  for (const primitive of primitives) {
    visit(primitive);
    walkPrimitives(nestedPrimitives(primitive), visit);
  }
}

/**
 * The `__wskit` tags of the primitives that declared a requirement on `kind`.
 * Uses each primitive's own self-declared identity — no capability-specific
 * mapping — so the resolver names the requiring features without knowing what
 * any of them are.
 */
function neededBy(primitives: readonly Primitive[], kind: string): string {
  const tags = new Set<string>();
  walkPrimitives(primitives, (p) => {
    if ((p.__requiresCapabilities ?? []).includes(kind)) tags.add(p.__wskit);
  });
  return [...tags].join(', ');
}

/**
 * Resolve every `__requiresCapabilities` a server's primitives declare against
 * the capabilities it lists.
 *
 * A primitive nested inside a `channel` primitive (e.g. `inbox`, `readReceipts`)
 * can satisfy a requirement two ways: from the capability kinds declared in
 * that channel's OWN `capabilities` list first (e.g. `readReceipts` requiring
 * `inbox` on the same channel), then from the host/plugin's top-level list. A
 * top-level primitive only has the top-level list.
 *
 * On an app a required capability that is not listed anywhere reachable is a
 * build error. On a plugin's scoped handler (`define({ scope: 'plugin' })`) a
 * required capability that the plugin cannot own (a host-owned engine) is not
 * an error — it is returned as a host dependency, so the plugin can declare it
 * implicitly and the host must provide it. A plugin missing a capability it
 * *could* own is still a build error: it should list it itself.
 */
export function resolveCapabilityRequirements(
  primitives: readonly Primitive[],
  capabilities: readonly AnyCapability[],
  options: { scoped: boolean },
): { hostDependencies: readonly string[] } {
  const present = new Set<string>();
  for (const cap of capabilities) {
    if (cap.__capabilityKind) present.add(cap.__capabilityKind);
  }

  const hostDependencies = new Set<string>();

  // A primitive stamped `__plugin` (or nested under one) already had its
  // requirements resolved by that plugin's own scoped `assemble()` — against
  // the plugin's own capabilities, with host-owned kinds recorded as
  // `__hostDependencies`. Re-checking it here against the HOST's capability
  // list is both redundant and wrong: the plugin owns capabilities (like
  // `channels()`) that the host deliberately does not list. Once the walk
  // enters a plugin's subtree, every descendant is skipped — a channel's
  // nested children (e.g. `inbox`) only inherit `__plugin` themselves when
  // they're an event-routing kind, so the flag must propagate down the
  // recursion rather than being re-derived from each primitive.
  function walk(
    scope: readonly Primitive[],
    channelLocal: ReadonlySet<string> | undefined,
    insidePlugin: boolean,
  ): void {
    for (const primitive of scope) {
      const inPlugin = insidePlugin || Boolean((primitive as { __plugin?: string }).__plugin);
      if (!inPlugin) {
        for (const kind of primitive.__requiresCapabilities ?? []) {
          if (present.has(kind) || channelLocal?.has(kind)) continue;
          if (options.scoped && HOST_ONLY_CAPABILITY_KINDS.has(kind)) {
            hostDependencies.add(kind);
            continue;
          }
          const name = capabilityDisplayName(kind);
          const where = channelLocal
            ? `this channel's capabilities, or to define({ capabilities: [...] })`
            : 'capabilities';
          throw new Error(
            `[wskit] The ${name} capability is required by ${neededBy(primitives, kind)} but is not listed. Add ${name} to ${where}.`,
          );
        }
      }
      const nested = nestedPrimitives(primitive);
      if (nested.length === 0) continue;
      walk(
        nested,
        primitive.__wskit === 'channel' ? channelCapabilityKinds(primitive) : channelLocal,
        inPlugin,
      );
    }
  }

  walk(primitives, undefined, false);
  return { hostDependencies: [...hostDependencies] };
}

/**
 * The capability kinds a channel primitive declares as its own local scope —
 * stamped on it by `ChannelBuilder` from the `__capabilityKind` of each
 * capability in that channel's own `capabilities` list (e.g. `inbox()`,
 * `readReceipts()`). This is the requirement-matching namespace
 * (`CAPABILITY_KIND.*`); it is never inferred from a primitive's `__wskit` tag,
 * which is a display identity and is not guaranteed to equal its capability's
 * kind.
 */
function channelCapabilityKinds(primitive: Primitive): ReadonlySet<string> {
  return (primitive as { __capabilityKinds?: ReadonlySet<string> }).__capabilityKinds ?? new Set();
}
