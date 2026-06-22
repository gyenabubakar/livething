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
 * On an app (`scoped: false`) a required capability that is not listed is a
 * build error. On a plugin's scoped handler (`scoped: true`) a required
 * capability that the plugin cannot own (a host-owned engine) is not an error —
 * it is returned as a host dependency, so the plugin can declare it implicitly
 * and the host must provide it. A plugin missing a capability it *could* own is
 * still a build error: it should list it itself.
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

  const required = new Set<string>();
  walkPrimitives(primitives, (primitive) => {
    for (const kind of primitive.__requiresCapabilities ?? []) required.add(kind);
  });

  const hostDependencies = new Set<string>();
  for (const kind of required) {
    if (present.has(kind)) continue;
    if (options.scoped && HOST_ONLY_CAPABILITY_KINDS.has(kind)) {
      hostDependencies.add(kind);
      continue;
    }
    const name = capabilityDisplayName(kind);
    throw new Error(
      `[wskit] The ${name} capability is required by ${neededBy(primitives, kind)} but is not listed. Add ${name} to capabilities.`,
    );
  }

  return { hostDependencies: [...hostDependencies] };
}
