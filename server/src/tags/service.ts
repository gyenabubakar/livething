import { definePrimitive } from '~/primitive.ts';
import { restorePersistentTags } from '~/tags/rejoin.ts';
import { ensureTagsSchema, purgeTagsByUser } from '~/tags/storage.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { TagPersistenceService } from '~/_engine/runtime/feature-slots.ts';

/**
 * The persistent-tag restore operation, reached through the engine's
 * `tagPersistenceService` slot. Registered by the `tags()` capability — a
 * handler that never lists it never pulls the tag storage or rejoin code.
 */
export const tagPersistenceService: TagPersistenceService = {
  restorePersistentTags,
};

const TAG_PERSISTENCE_RUNTIME_KEY = Symbol('tag-persistence-runtime');

/**
 * Wire the durable tag table, the persistent-tag restore service, and the
 * `purgeUser` cleanup hook into the engine. `installOnce` keeps this a
 * single-time setup even when several tag groups are declared.
 */
export function registerTagPersistenceRuntime(engine: EngineAccess): void {
  engine.installOnce(TAG_PERSISTENCE_RUNTIME_KEY, () => {
    engine.setTagPersistenceService(tagPersistenceService);

    engine.onBootSchema(() => {
      ensureTagsSchema(engine.storage.sql);
    });

    engine.onPurgeUser((core, userId) => {
      purgeTagsByUser((core as EngineCore).storage.sql, userId);
    });
  });
}

export const tagPersistenceRuntimePrimitive = definePrimitive({
  tag: 'tag-persistence-runtime',
  key: Symbol('tag-persistence-runtime-primitive'),
  kind: 'infrastructure',
  create: () => ({}),
  setup(engine) {
    registerTagPersistenceRuntime(engine);
  },
});
