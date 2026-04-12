import type { Primitive } from '~/primitive.ts';

/** A primitive that holds child primitives (namespace, channel, group). */
type NestedPrimitive = Primitive & { primitives: readonly Primitive[] };

/** Returns `true` when a primitive has a child `primitives` list to recurse into. */
function hasNestedPrimitives(primitive: Primitive): primitive is NestedPrimitive {
  return (
    primitive.__wskit === 'namespace' ||
    primitive.__wskit === 'channel' ||
    primitive.__wskit === 'group'
  );
}

/**
 * Build a human-readable label for a primitive used in error messages.
 *
 * Examples: `"incoming(send-message)"`, `"ack"`, `"channel(room)"`.
 * When no `registrationId` is set the tag alone is sufficient.
 */
function identityLabel(primitive: Primitive): string {
  const [, registrationId] = primitive.__identity;
  return registrationId ? `${primitive.__wskit}(${registrationId})` : primitive.__wskit;
}

/**
 * Walk the full primitive tree and return the set of identity keys that are
 * actually registered.
 *
 * `refs` accumulates as the recursion walks nested scopes, so the final
 * dependency check has a complete picture of everything available.
 */
function collectRegisteredRefs(
  primitives: readonly Primitive[],
  refs = new Set<symbol>(),
): Set<symbol> {
  for (const primitive of primitives) {
    refs.add(primitive.__identity[0]);

    if (hasNestedPrimitives(primitive)) {
      collectRegisteredRefs(primitive.primitives, refs);
    }
  }

  return refs;
}

/**
 * Walk the primitive tree and throw if the same primitive is registered twice
 * in the same scope.
 *
 * Identity is tracked by the combination of `key` symbol and `registrationId`.
 * Two `incoming('send-message')` calls share the same key and the same
 * registrationId, so the second one throws. Two `channel()` calls with
 * different names share the same key but have different registrationIds,
 * so they are both valid.
 *
 * Each nested scope (namespace, channel, group) gets its own fresh `seen`
 * map — duplicates across scopes are fine, only within-scope duplicates
 * are an error.
 */
function validateUniqueIdentities(
  primitives: readonly Primitive[],
  seen = new Map<symbol, Set<string | undefined>>(),
): void {
  for (const primitive of primitives) {
    const [key, registrationId] = primitive.__identity;
    const registrations = seen.get(key) ?? new Set<string | undefined>();

    if (registrations.has(registrationId)) {
      throw new Error(
        `[wskit] Duplicate registration: ${identityLabel(primitive)} is registered more than once in the same scope.`,
      );
    }

    registrations.add(registrationId);
    seen.set(key, registrations);

    if (hasNestedPrimitives(primitive)) {
      // Pass a fresh map for each nested scope — isolation is intentional.
      validateUniqueIdentities(primitive.primitives, new Map());
    }
  }
}

/**
 * Walk the primitive tree and throw if a primitive declares a dependency on
 * another primitive that was not registered.
 *
 * Dependencies are expressed as `PrimitiveRef` objects (factory functions with
 * a `__key` symbol). A dependency is satisfied if its `__key` appears anywhere
 * in the full set of registered refs, including nested scopes.
 */
function validateDependencies(
  primitives: readonly Primitive[],
  registeredRefs: ReadonlySet<symbol>,
): void {
  for (const primitive of primitives) {
    for (const dependency of primitive.__dependencies) {
      if (!registeredRefs.has(dependency.__key)) {
        throw new Error(
          `[wskit] ${identityLabel(primitive)} requires a missing dependency. Register the required primitive in your server builder.`,
        );
      }
    }

    if (hasNestedPrimitives(primitive)) {
      validateDependencies(primitive.primitives, registeredRefs);
    }
  }
}

/**
 * Run all build-time checks on a finalized list of primitives.
 *
 * Called automatically by `ServerBuilder.done()` before the `ServerDefinition`
 * is frozen. You should never need to call this directly.
 *
 * Performs two checks in order:
 * 1. **Unique identities** — no primitive is registered twice in the same scope.
 * 2. **Satisfied dependencies** — every primitive's declared dependencies are
 *    present somewhere in the tree.
 *
 * Both checks recurse into nested scopes (channels, namespaces, groups).
 *
 * @throws {Error} On the first violation found.
 */
export function validateBuild(primitives: readonly Primitive[]): void {
  validateUniqueIdentities(primitives);
  validateDependencies(primitives, collectRegisteredRefs(primitives));
}
