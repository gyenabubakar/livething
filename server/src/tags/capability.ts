import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { tagPersistenceRuntimePrimitive } from '~/tags/service.ts';
import { resolveTagGroupDefs, tagGroups } from '~/tags/tags.ts';
import type { Capability, UnionToIntersection } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  TagGroupBuilder,
  TagGroupDef,
  TagGroupRegistration,
  TagsConfig,
} from '~/tags/tags.ts';
import type { TagKind } from '~/tags/types.ts';

/**
 * The `(ephemeral, persistent) => [...]` callback that declares a server's tag
 * groups. Each call to `ephemeral(name, type?)` or `persistent(name, type?)`
 * declares one group; the returned array is the full set.
 */
export type TagsBuilder<TDefs extends readonly TagGroupDef[]> = (
  ephemeral: TagGroupBuilder<'ephemeral'>,
  persistent: TagGroupBuilder<'persistent'>,
) => TDefs;

/** Turn one declared def into its `{ name: valueType }` entry, or drop it if the kind differs. */
type TagEntry<TDef, TKind extends TagKind> =
  TDef extends TagGroupDef<TKind, infer TName, infer TValue> ? { [K in TName]: TValue } : never;

/** Collapse the never/non-record cases of a merged tag map to an empty record. */
type TagMapOrEmpty<T> = [T] extends [never] ? {} : T extends Record<string, unknown> ? T : {};

/** One kind's group-name → value-type map, read off all declared defs. */
type TagMapOfKind<TDefs extends readonly TagGroupDef[], TKind extends TagKind> = TagMapOrEmpty<
  UnionToIntersection<TagEntry<TDefs[number], TKind>>
>;

/**
 * The server-only contract slots a `tags(...)` capability declares. They drive
 * the typed group names on `ctx.tags` but never reach the client contract — tags
 * are infrastructure for grouping connections, not wire messages.
 */
type TagsSlots<TDefs extends readonly TagGroupDef[]> = {
  ephemeralTags: TagMapOfKind<TDefs, 'ephemeral'>;
  persistentTags: TagMapOfKind<TDefs, 'persistent'>;
};

/** A `tags(...)` capability — declares tag groups and pulls in the tag engine. */
export interface TagsCapability<
  TDefs extends readonly TagGroupDef[] = readonly TagGroupDef[],
> extends Capability<TagsSlots<TDefs>, never> {}

/** Collect one kind's groups into the registration shape the engine primitive expects. */
function registrationsFor(defs: readonly TagGroupDef[], kind: TagKind): TagGroupRegistration[] {
  return defs
    .filter((def) => def.kind === kind)
    .map((def) => ({ name: def.name, schema: def.schema }));
}

/**
 * Enable tags — named groups you attach to connections to address or count them
 * (for example everyone with `role:admin`). Listing this grants the `ctx.tags`
 * surface and the optional initial ephemeral tags in `upgrade(...)`. Persistent
 * groups survive restarts; ephemeral ones do not.
 *
 * Declare groups with the two builders: `ephemeral(name, type?)` for in-memory
 * groups and `persistent(name, type?)` for durable ones. A `t<T>()` marker types
 * the value with no runtime cost; a schema (for example `v.picklist([...])`)
 * also validates the value on `add()`.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { tags } from '@wskit/server/tags';
 * import * as v from 'valibot';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [
 *     tags((ephemeral, persistent) => [
 *       ephemeral('role', t<string>()),
 *       ephemeral('color', v.picklist(['red', 'blue', 'green'])),
 *       persistent('favorite', t<string>()),
 *     ]),
 *   ],
 * });
 *
 * export const handlePromote = base.on('promote', {
 *   run(ctx) {
 *     ctx.tags.ephemeral('role').add('admin');
 *     ctx.tags.ephemeral('role').ref('admin').send('announce', { text: 'hi admins' });
 *   },
 * });
 *
 * export const server = base.assemble({ handlers: [handlePromote] });
 * ```
 */
export const tags = withCapabilityKind(function tags<const TDefs extends readonly TagGroupDef[]>(
  builder: TagsBuilder<TDefs>,
): TagsCapability<TDefs> {
  const defs = resolveTagGroupDefs(builder as TagsConfig);
  const primitives: Primitive[] = [tagPersistenceRuntimePrimitive()];
  const ephemeral = registrationsFor(defs, 'ephemeral');
  const persistent = registrationsFor(defs, 'persistent');
  if (ephemeral.length > 0) primitives.push(tagGroups('ephemeral', ephemeral));
  if (persistent.length > 0) primitives.push(tagGroups('persistent', persistent));
  return stampKind(
    capability<TagsSlots<TDefs>, never>(primitives) as TagsCapability<TDefs>,
    CAPABILITY_KIND.tags,
  );
}, CAPABILITY_KIND.tags);
