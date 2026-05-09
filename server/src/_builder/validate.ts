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
 * Collect the identity keys registered directly in a scope.
 *
 * Groups expand into their parent scope at compile time, so their refs are
 * pulled up here. Channels and namespaces own their own scope and are not
 * walked into.
 */
function collectScopeRefs(primitives: readonly Primitive[], refs = new Set<symbol>()): Set<symbol> {
  for (const primitive of primitives) {
    refs.add(primitive.__identity[0]);

    if (hasNestedPrimitives(primitive) && primitive.__wskit === 'group') {
      collectScopeRefs(primitive.primitives, refs);
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
 * another primitive that was not registered in its scope (or an outer scope).
 *
 * Visibility rules:
 * - Server-level refs are visible everywhere.
 * - Refs registered inside a channel are visible only inside that channel.
 * - Namespace-local refs are visible only inside that namespace, but the
 *   namespace inherits its parent scope's refs.
 * - Groups expand into the parent scope, so their refs are pulled up by
 *   `collectScopeRefs` before the walk.
 *
 * `parentRefs` is the set of refs visible from outside this scope. Each
 * scope adds its own primitives (and groups, recursively) on top of that
 * before checking dependencies and recursing into nested channels and
 * namespaces.
 */
function validateScopeDependencies(
  primitives: readonly Primitive[],
  parentRefs: ReadonlySet<symbol>,
): void {
  const scopeRefs = collectScopeRefs(primitives, new Set(parentRefs));
  walkScope(primitives, scopeRefs);
}

function walkScope(primitives: readonly Primitive[], scopeRefs: ReadonlySet<symbol>): void {
  for (const primitive of primitives) {
    for (const dependency of primitive.__dependencies) {
      if (!scopeRefs.has(dependency.__key)) {
        throw new Error(
          `[wskit] ${identityLabel(primitive)} requires a missing dependency. Register the required primitive in the same scope or an outer scope.`,
        );
      }
    }

    if (!hasNestedPrimitives(primitive)) continue;

    if (primitive.__wskit === 'group') {
      walkScope(primitive.primitives, scopeRefs);
    } else {
      validateScopeDependencies(primitive.primitives, scopeRefs);
    }
  }
}

/**
 * Walk a scope and refuse to build when the same wire event name is used by
 * more than one of `incoming`, `request`, or `stream` in that scope.
 *
 * The per-primitive `validateUniqueIdentities` check above keys on each
 * primitive's symbol, so two registrations with the same event name but
 * different primitive kinds (e.g. `incoming('foo')` and `request('foo')`)
 * pass it. At dispatch the engine looks up all three maps and picks
 * `incoming ?? request ?? stream`, so the loser is unreachable and a
 * client `request(...)` against a shadowed name hangs forever.
 *
 * Groups are expanded into their parent scope (same as the dependency check).
 * Each channel and namespace gets its own scope walk.
 */
function validateNoCrossPrimitiveEventCollisions(primitives: readonly Primitive[]): void {
  const seen = new Map<string, string>();

  function recordOrThrow(event: string, kind: string): void {
    const previous = seen.get(event);
    if (previous && previous !== kind) {
      throw new Error(
        `[wskit] Event name '${event}' is registered as both '${previous}' and '${kind}' in the same scope. ` +
          `An event name can only be used by one of incoming/request/stream within a scope — pick a different name.`,
      );
    }
    seen.set(event, kind);
  }

  function collect(list: readonly Primitive[]): void {
    for (const primitive of list) {
      if (primitive.__wskit === 'incoming') {
        recordOrThrow((primitive as Primitive & { event: string }).event, 'incoming');
      } else if (primitive.__wskit === 'request') {
        recordOrThrow((primitive as Primitive & { event: string }).event, 'request');
      } else if (primitive.__wskit === 'generate') {
        recordOrThrow((primitive as Primitive & { event: string }).event, 'stream');
      } else if (primitive.__wskit === 'group') {
        collect((primitive as NestedPrimitive).primitives);
      }
    }
  }

  collect(primitives);

  function recurseIntoNestedScopes(list: readonly Primitive[]): void {
    for (const primitive of list) {
      if (primitive.__wskit === 'channel' || primitive.__wskit === 'namespace') {
        validateNoCrossPrimitiveEventCollisions((primitive as NestedPrimitive).primitives);
      } else if (primitive.__wskit === 'group') {
        recurseIntoNestedScopes((primitive as NestedPrimitive).primitives);
      }
    }
  }
  recurseIntoNestedScopes(primitives);
}

/**
 * Run all build-time checks on a finalized list of primitives.
 *
 * Called automatically by `ServerBuilder.build()` before the `ServerDefinition`
 * is frozen. You should never need to call this directly.
 *
 * Performs three checks in order:
 * 1. **Unique identities** — no primitive is registered twice in the same scope.
 * 2. **Cross-primitive event names** — no event name is shared by more than
 *    one of incoming/request/stream within a scope.
 * 3. **Satisfied dependencies** — every primitive's declared dependencies are
 *    present somewhere in the tree.
 *
 * All checks recurse into nested scopes (channels, namespaces, groups).
 *
 * @throws {Error} On the first violation found.
 */
export function validateBuild(primitives: readonly Primitive[]): void {
  validateUniqueIdentities(primitives);
  validateNoCrossPrimitiveEventCollisions(primitives);
  validateScopeDependencies(primitives, new Set());
}
