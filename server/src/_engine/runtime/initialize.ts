/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { installPrimitiveHooks } from '~/_engine/registry/install.ts';
import { createPluginHooks } from '~/_engine/registry/plugin-hooks.ts';
import { isSchemaInitialized, markSchemaInitialized } from '~/_engine/runtime/schema-meta.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type PluginRuntime = EngineRuntimeTypes.PluginRuntime;

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
    throw new Error('[wskit] replay() requires sequence({ persist: true }) for durable replay.');
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

  for (const pluginInstance of core.compiled.plugins) {
    // Plugins can declare typed errors via `definitions: [error('acme/denied',
    // schema)]`. Register each declared code so handleRuntimeError no longer
    // logs the "not declared" warning and the client sees a known code.
    if (pluginInstance.errors?.defs) {
      for (const def of pluginInstance.errors.defs) {
        core.declaredErrorCodes.add(def.code);
      }
    }

    const runtime: PluginRuntime = {
      instance: pluginInstance,
      contextFactory: () => ({}),
    };
    runtime.contextFactory = pluginInstance.setupPlugin(
      pluginInstance.args,
      createPluginHooks(core, runtime, accessDeps.ensureScheduledRuntime),
    );
    core.pluginRuntimes.push(runtime);

    // A plugin can declare scheduled tasks in `definitions: [scheduled(...)]`,
    // which is the type-level source. Runtime registration happens in setup()
    // via `hooks.scheduled(name, ...)`. If the plugin declared a task but
    // never wired its handler, the prefixed task id is missing from the
    // engine's scheduled map — ctx.schedule(...) would throw "not registered"
    // at the first call, far from the misconfig. Fail fast at boot instead.
    for (const def of pluginInstance.scheduled) {
      const prefixed = `__${pluginInstance.id}:${def.name}`;
      const registered = core.compiled.scheduled.get(prefixed);
      if (!registered) {
        throw new Error(
          `[wskit] Plugin "${pluginInstance.id}" declared scheduled task "${def.name}" in definitions ` +
            `but its setup() did not call hooks.scheduled("${def.name}", ...) to wire a handler.`,
        );
      }
      // If the declaration carries a data schema, the runtime registration
      // must also be hasData. Otherwise the typed `ctx.schedule(name, {data})`
      // would type-check but the handler would silently ignore the payload.
      const declaration = (def as { declaration?: { data?: unknown } }).declaration;
      if (declaration?.data !== undefined && !registered.hasData) {
        throw new Error(
          `[wskit] Plugin "${pluginInstance.id}" declared scheduled task "${def.name}" with a data schema ` +
            `but setup() registered it without .data(...). Call .data(<same schema>).run(...) inside hooks.scheduled("${def.name}", ...).`,
        );
      }
    }
  }

  // Schema-init hooks (CREATE TABLE IF NOT EXISTS) only run when the marker
  // row says storage is not on the current schema version. On a fresh
  // instance the SELECT throws and we treat it as not-initialized.
  const storageForSchema = core.storage;
  if (core.hooks.bootSchema.length > 0) {
    const initialized = storageForSchema ? isSchemaInitialized(storageForSchema.sql) : false;
    if (!initialized) {
      for (const hook of core.hooks.bootSchema) {
        await hook();
      }
      if (storageForSchema) {
        markSchemaInitialized(storageForSchema.sql);
        core.freshBoot = true;
      }
    }
  }

  // Always-run boot hooks (cleanup, state restore). These never skip.
  for (const hook of core.hooks.boot) {
    await hook();
  }

  const initCtx = EngineContexts.createInitContext({
    env: core.env,
    logger: core.logger,
    platform: core.platform,
    requireStorage: () => core.requireStorage(),
  });
  for (const hook of core.hooks.init) {
    await hook(initCtx);
  }
  for (const runtime of core.pluginRuntimes) {
    if (runtime.onInit) {
      await runtime.onInit(
        EngineContexts.createPluginScopedContext(
          runtime.instance.id,
          initCtx as unknown as Record<PropertyKey, unknown>,
        ),
      );
    }
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
