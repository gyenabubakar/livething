import { assertValidWSKitIdentifier } from '@wskit/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { buildTagsApi } from '~/tags/runtime.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Primitive } from '~/primitive.ts';
import type { TagKind } from '~/tags/types.ts';
import type { Validator } from '~/types.ts';

/**
 * How a tag group's value type is declared: a `t<T>()` marker (compile-time
 * only, no runtime cost) or a Standard Schema (compile-time type plus runtime
 * validation on `add()`). `TValue` is constrained to `string` because a tag
 * value is stored as a string key.
 */
export type TagValueType<TValue extends string> =
  | TypeMarker<TValue>
  | StandardSchemaV1<unknown, TValue>;

/** One tag group declared through the contract's `tags:` builder. */
export interface TagGroupDef<
  TKind extends TagKind = TagKind,
  TName extends string = string,
  TValue extends string = string,
> {
  readonly __wskit_tag_def: true;
  readonly kind: TKind;
  readonly name: TName;
  /** Runtime validator — present only when the group was declared with a Standard Schema. */
  readonly schema?: Validator;
  /** Phantom carrier for the value type; never set at runtime. */
  readonly _value?: TValue;
}

/** The per-kind builder handed to the contract's `tags:` callback. */
export type TagGroupBuilder<TKind extends TagKind> = <
  TName extends string,
  TValue extends string = string,
>(
  name: TName,
  type?: TagValueType<TValue>,
) => TagGroupDef<TKind, TName, TValue>;

/** Shape of the contract's `tags:` config callback. */
export type TagsConfig = (
  ephemeral: TagGroupBuilder<'ephemeral'>,
  persistent: TagGroupBuilder<'persistent'>,
) => readonly TagGroupDef[];

function isStandardSchema(value: unknown): value is Validator {
  return !!value && typeof value === 'object' && '~standard' in value;
}

function makeTagGroupBuilder<TKind extends TagKind>(kind: TKind): TagGroupBuilder<TKind> {
  function builder(name: string, type?: unknown): TagGroupDef<TKind, string, string> {
    return {
      __wskit_tag_def: true,
      kind,
      name,
      schema: isStandardSchema(type) ? type : undefined,
    };
  }
  return builder as TagGroupBuilder<TKind>;
}

/** Run a `tags:` config callback and return the declared group defs. */
export function resolveTagGroupDefs(tags: TagsConfig): readonly TagGroupDef[] {
  return tags(makeTagGroupBuilder('ephemeral'), makeTagGroupBuilder('persistent'));
}

/** A single group's runtime registration shape: its name and optional validator. */
export interface TagGroupRegistration {
  readonly name: string;
  readonly schema?: Validator;
}

/** The TypeScript type returned by `tagGroups(kind, defs)`. */
export interface TagGroupsPrimitive<
  TKind extends TagKind = TagKind,
> extends Primitive<'tag-groups'> {
  readonly kind: TKind;
  readonly groups: readonly TagGroupRegistration[];
}

/** @internal */
const TAG_GROUPS_EPHEMERAL_KEY = Symbol('tag-groups-ephemeral');
/** @internal */
const TAG_GROUPS_PERSISTENT_KEY = Symbol('tag-groups-persistent');
/** Installs the `ctx.tags` builder once, however many group kinds are listed. @internal */
const TAG_API_KEY = Symbol('tag-api');

function validateGroupRegistrations(kind: TagKind, groups: readonly TagGroupRegistration[]): void {
  if (groups.length === 0) {
    throw new Error(`[wskit] tagGroups('${kind}', ...) requires at least one group name.`);
  }
  const seen = new Set<string>();
  for (const { name } of groups) {
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
 * Declares one kind of tag groups. Registered via the contract's `tags:`
 * builder — most apps don't call this primitive directly.
 *
 * Same-kind, same-name declarations throw at boot. Cross-kind same-name
 * declarations are allowed — `ephemeral 'role'` and `persistent 'role'` are
 * independent groups.
 *
 * @internal
 */
export function tagGroups<TKind extends TagKind>(
  kind: TKind,
  groups: readonly TagGroupRegistration[],
): TagGroupsPrimitive<TKind> {
  validateGroupRegistrations(kind, groups);
  const key = kind === 'ephemeral' ? TAG_GROUPS_EPHEMERAL_KEY : TAG_GROUPS_PERSISTENT_KEY;
  return {
    __wskit: 'tag-groups',
    __kind: 'infrastructure',
    __identity: [key],
    __requires: kind === 'persistent' ? { storage: true } : {},
    __requiresCapabilities: kind === 'persistent' ? [CAPABILITY_KIND.persistence] : [],
    kind,
    groups,
    __setup(engine) {
      engine.registerTagGroups(kind, groups);
      engine.installOnce(TAG_API_KEY, () => {
        engine.setBuildTagsApi(buildTagsApi);
      });
    },
  };
}

tagGroups.__ephemeralKey = TAG_GROUPS_EPHEMERAL_KEY;
tagGroups.__persistentKey = TAG_GROUPS_PERSISTENT_KEY;
