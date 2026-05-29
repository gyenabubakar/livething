import { assertValidWSKitIdentifier } from '@wskit/core';
import type { Primitive } from '~/primitive.ts';
import type { TagKind } from '~/tags/types.ts';

/** The TypeScript type returned by `tagGroups(kind, names)`. */
export interface TagGroupsPrimitive<
  TKind extends TagKind = TagKind,
> extends Primitive<'tag-groups'> {
  readonly kind: TKind;
  readonly groups: readonly string[];
}

/** @internal */
const TAG_GROUPS_EPHEMERAL_KEY = Symbol('tag-groups-ephemeral');
/** @internal */
const TAG_GROUPS_PERSISTENT_KEY = Symbol('tag-groups-persistent');

function validateGroupNames(kind: TagKind, names: readonly string[]): void {
  if (names.length === 0) {
    throw new Error(`[wskit] tagGroups('${kind}', ...) requires at least one group name.`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    assertValidWSKitIdentifier(name, `tagGroups('${kind}', ...) name`);
    if (seen.has(name)) {
      throw new Error(
        `[wskit] tagGroups('${kind}', ...): '${name}' declared twice in the same call.`,
      );
    }
    seen.add(name);
  }
}

/**
 * Declares one kind of tag groups. Registered via `tagGroups:` on the
 * contract config — most apps don't call this primitive directly.
 *
 * Same-kind, same-name declarations throw at boot. Cross-kind same-name
 * declarations are allowed — `ephemeral 'role'` and `persistent 'role'` are
 * independent groups.
 *
 * @internal
 */
export function tagGroups<TKind extends TagKind>(
  kind: TKind,
  groups: readonly string[],
): TagGroupsPrimitive<TKind> {
  validateGroupNames(kind, groups);
  const key = kind === 'ephemeral' ? TAG_GROUPS_EPHEMERAL_KEY : TAG_GROUPS_PERSISTENT_KEY;
  return {
    __wskit: 'tag-groups',
    __kind: 'infrastructure',
    __identity: [key],
    __requires: kind === 'persistent' ? { storage: true } : {},
    kind,
    groups,
    __setup(engine) {
      engine.registerTagGroups(kind, groups);
    },
  };
}

tagGroups.__ephemeralKey = TAG_GROUPS_EPHEMERAL_KEY;
tagGroups.__persistentKey = TAG_GROUPS_PERSISTENT_KEY;
