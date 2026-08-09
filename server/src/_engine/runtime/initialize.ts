/* oxlint-disable @typescript-eslint/no-explicit-any */
import { installPrimitiveHooks } from '~/_engine/registry/install.ts';
import { markSchemaInitialized, readSchemaState } from '~/_engine/runtime/schema-meta.ts';
import { createInitContext } from '~/lifecycle/context.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type { Primitive, ValidationView } from '~/primitive.ts';

/** Throw if the adapter is missing something the handler said it needs. */
function validateRequires(core: EngineCore): void {
  const requires = core.compiled.requires;
  if (requires.hibernation && !core.options.hibernation) {
    throw new Error(
      `[wskit] Handler requires hibernation, but adapter "${core.options.adapterId}" does not support it.`,
    );
  }
}

/**
 * Run every primitive's `__validate` against settled engine state, after all
 * setups. Each capability owns its own runtime-state rule (replay checks a
 * persistent sequence, revalidate checks a persistent channel) — the engine
 * just walks the tree and threads each primitive's channel scope, staying
 * oblivious to what any capability requires.
 */
function validatePrimitives(core: EngineCore): void {
  function visit(primitives: readonly Primitive[], channelKey?: string): void {
    const view: ValidationView = {
      sequencePersistent: core.sequencePersistent,
      channelKey,
      isChannelPersistent(key: string): boolean {
        return core.isChannelPersistent(key);
      },
    };
    for (const primitive of primitives) {
      primitive.__validate?.(view);
      if (primitive.__wskit === 'channel') {
        const channelPrimitive = primitive as Primitive & {
          pattern: string | { key: string };
          primitives: readonly Primitive[];
        };
        visit(
          channelPrimitive.primitives,
          typeof channelPrimitive.pattern === 'string'
            ? channelPrimitive.pattern
            : channelPrimitive.pattern.key,
        );
      }
    }
  }

  visit(core.primitives);
}

/**
 * One-time startup. Validate capabilities, install primitives and plugins,
 * then run boot hooks and init hooks.
 *
 * Safe to call from anywhere, any number of times: the first call owns the run
 * and every later one joins it. A failed run stays failed rather than retrying
 * — hook installation is additive, so a second attempt over a half-installed
 * engine would duplicate every hook it already registered.
 */
export function initialize(core: EngineCore, accessDeps: EngineAccessDeps): Promise<void> {
  if (core.initPromise) return core.initPromise;

  // The run is published before it is started, not after. `runInitialize` gets
  // as far as calling the first init hook before it ever suspends, so a hook
  // that reaches back into `initialize()` would still find an empty field and
  // start a second run.
  let succeed!: () => void;
  let fail!: (error: unknown) => void;
  core.initPromise = new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  });
  runInitialize(core, accessDeps).then(succeed, fail);

  return core.initPromise;
}

async function runInitialize(core: EngineCore, accessDeps: EngineAccessDeps): Promise<void> {
  validateRequires(core);
  installPrimitiveHooks(core, accessDeps);
  if (core.compiled.scheduled.size > 0) {
    accessDeps.ensureScheduledRuntime();
  }
  validatePrimitives(core);

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

  const initCtx = createInitContext({
    env: core.env,
    logger: core.logger,
    platform: core.platform,
    getStorage: () => core.storage,
  });
  // Inbound onion: new-model plugin inits run before the app's. Their
  // handlers are already wrapped in a plugin-scoped context.
  for (const entry of core.hooks.pluginLifecycle.init) {
    await entry.handler(initCtx);
  }
  for (const hook of core.hooks.init) {
    await hook(initCtx);
  }
}

/** Adapter scheduled-callback entry. Runs `initialize` first, then walks scheduled hooks. */
export async function handleAlarm(core: EngineCore, accessDeps: EngineAccessDeps): Promise<void> {
  await initialize(core, accessDeps);
  for (const hook of core.hooks.alarm) {
    await hook();
  }
}
