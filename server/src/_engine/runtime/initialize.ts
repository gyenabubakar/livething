/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { installPrimitiveHooks } from '~/_engine/registry/install.ts';
import { markSchemaInitialized, readSchemaState } from '~/_engine/runtime/schema-meta.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';

/** Throw if the adapter is missing something the handler said it needs. */
function validateRequires(core: EngineCore): void {
  const requires = core.compiled.requires;
  if (requires.storage && !core.storage) {
    throw new Error(
      `[wskit] Handler requires storage, but adapter "${core.options.adapterId}" did not provide it.`,
    );
  }
  if (requires.timers && !core.timers) {
    throw new Error(
      `[wskit] Handler requires timers, but adapter "${core.options.adapterId}" did not provide it.`,
    );
  }
  if (requires.hibernation && !core.options.hibernation) {
    throw new Error(
      `[wskit] Handler requires hibernation, but adapter "${core.options.adapterId}" does not support it.`,
    );
  }
}

/** Throw if the adapter is missing engine-internal guarantees the primitives need. */
function validateEngineRequirements(core: EngineCore): void {
  if (core.replayEnabled && !core.sequencePersistent) {
    throw new Error('[wskit] replay requires `sequence: { persist: true }` for durable replay.');
  }
}

/**
 * Throw if a channel registered a `.revalidate()` hook but is not persistent.
 * `revalidate` only runs on auto-rejoin, which only happens for persistent
 * channels — so on a non-persistent channel it is dead code, and almost always
 * means the author meant to enable persistence or use `.check()` instead.
 */
function validateRevalidateRequiresPersistence(core: EngineCore): void {
  for (const channelKey of core.hooks.revalidate.keys()) {
    if (!core.isChannelPersistent(channelKey)) {
      throw new Error(
        `[wskit] Channel "${channelKey}" has a .revalidate() hook but is not persistent, so it would ` +
          `never run — revalidate fires only on auto-rejoin, which only happens for persistent channels. ` +
          `Enable persistence (contract \`persistence: true\`, and do not set \`persistent: false\` on this ` +
          `channel), or remove the .revalidate() hook (use \`.check()\` for first-subscribe authorization).`,
      );
    }
  }
}

/**
 * One-time startup. Validate capabilities, install primitives and plugins,
 * then run boot hooks and init hooks.
 */
export async function initialize(core: EngineCore, accessDeps: EngineAccessDeps): Promise<void> {
  if (core.initialized) return;
  validateRequires(core);
  installPrimitiveHooks(core, accessDeps);
  if (core.compiled.scheduled.size > 0) {
    accessDeps.ensureScheduledRuntime();
  }
  validateEngineRequirements(core);
  validateRevalidateRequiresPersistence(core);

  // Schema-init hooks (CREATE TABLE IF NOT EXISTS) only run when the marker
  // row says storage is not on the current schema version. On a fresh
  // instance the SELECT throws and we treat it as not-initialized.
  const storageForSchema = core.storage;
  if (core.hooks.bootSchema.length > 0) {
    const schemaState = storageForSchema
      ? readSchemaState(storageForSchema.sql)
      : { initialized: false, fresh: false };
    if (!schemaState.initialized) {
      for (const hook of core.hooks.bootSchema) {
        await hook();
      }
      if (storageForSchema) {
        markSchemaInitialized(storageForSchema.sql);
        // A migration (meta table present, older version) may already hold
        // membership rows, so the first auto-rejoin must not be skipped.
        core.freshBoot = schemaState.fresh;
      }
    }
  }

  for (const hook of core.hooks.boot) {
    await hook();
  }

  const initCtx = EngineContexts.createInitContext({
    env: core.env,
    logger: core.logger,
    platform: core.platform,
    requireStorage: () => core.requireStorage(),
  });
  // Inbound onion: new-model plugin inits run before the app's. Their
  // handlers are already wrapped in a plugin-scoped context.
  for (const entry of core.hooks.pluginLifecycle.init) {
    await entry.handler(initCtx);
  }
  for (const hook of core.hooks.init) {
    await hook(initCtx);
  }
  core.initialized = true;
}

/** Adapter scheduled-callback entry. Runs `initialize` first, then walks scheduled hooks. */
export async function handleAlarm(core: EngineCore, accessDeps: EngineAccessDeps): Promise<void> {
  await initialize(core, accessDeps);
  for (const hook of core.hooks.alarm) {
    await hook();
  }
}
