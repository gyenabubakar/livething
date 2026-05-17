import { applyFeature } from '~/_builder/apply-feature.ts';
import { tagGroups as createTagGroups } from '~/tags/tags.ts';
import type { BuilderInternals, ServerBuilderFull } from '~/_types/feature-methods.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';
import type { TagKind } from '~/tags/types.ts';

const KINDS = ['server'] as const;

/**
 * Add the typed tag API to a server builder.
 *
 * Once wrapped, you can call `.tagGroups(kind, names)` to declare groups of
 * each kind. Handlers get `ctx.tags.ephemeral(group)` and
 * `ctx.tags.persistent(group)` for membership reads/writes and fan-out.
 * `onUpgrade` gains a `tags` helper for building refs at upgrade time.
 *
 * Wrapping alone has no runtime effect — declare groups via `.tagGroups(...)`
 * to populate the surface.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withChannels } from '@wskit/server/channels';
 * import { withTags } from '@wskit/server/tags';
 *
 * withTags(withChannels(server('chat')))
 *   .tagGroups('ephemeral', ['role', 'tier', 'user'])
 *   .onUpgrade(async (req, { tags }) => ({
 *     identity: 'u-1',
 *     tags: [tags.ephemeral('role').ref('admin')],
 *   }));
 * ```
 */
export function withTags<TState extends ScopeStateShape, TFeatures>(
  builder: ServerBuilderFull<TState, TFeatures>,
): ServerBuilderFull<TState, TFeatures & { tags: true }> {
  applyFeature(builder, KINDS, (t) => {
    t.tagGroups = function (this: BuilderInternals, kind: TagKind, groups: readonly string[]) {
      this._primitives.push(createTagGroups(kind, groups) as unknown as Primitive);
      return this;
    };
  });
  return builder as ServerBuilderFull<TState, TFeatures & { tags: true }>;
}
