import type { Primitive } from '~/primitive.ts';

type NestedPrimitive = Primitive & { primitives: readonly Primitive[] };

function hasNestedPrimitives(primitive: Primitive): primitive is NestedPrimitive {
  return (
    primitive.__wskit === 'namespace' ||
    primitive.__wskit === 'channel' ||
    primitive.__wskit === 'group'
  );
}

function identityLabel(primitive: Primitive): string {
  const [, registrationId] = primitive.__identity;
  return registrationId ? `${primitive.__wskit}(${registrationId})` : primitive.__wskit;
}

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
      validateUniqueIdentities(primitive.primitives, new Map());
    }
  }
}

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

export function validateBuild(primitives: readonly Primitive[]): void {
  validateUniqueIdentities(primitives);
  validateDependencies(primitives, collectRegisteredRefs(primitives));
}
