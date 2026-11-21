/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  beginAlarmDelivery,
  endAlarmDelivery,
  ensureAlarmCoordinatorSchema,
  rescheduleAlarm,
  restoreAlarmCoordinator,
} from '~/_engine/alarm.ts';
import { withCallContext } from '~/_engine/async-context.ts';
import { commonDeps } from '~/_engine/engine.deps.ts';
import { installPrimitiveHooks } from '~/_engine/registry/install.ts';
import { markSchemaInitialized, readSchemaState } from '~/_engine/runtime/schema-meta.ts';
import { createHostContext } from '~/lifecycle/context.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type { Primitive, ValidationView } from '~/primitive.ts';

const ALARM_RETRY_DELAY_MS = 1_000;

/** Throw if the adapter is missing something the server definition said it needs. */
function validateRequires(core: EngineCore): void {
  const requires = core.compiled.requires;
  if (requires.hibernation && !core.options.hibernation) {
    throw new Error(
      `[livething] Server definition requires hibernation, but adapter "${core.options.adapterId}" does not support it.`,
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
      receiveBytes: core.messageLimits.receiveBytes,
      channelKey,
      isChannelDurable(key: string): boolean {
        return core.isChannelDurable(key);
      },
      hasPresence(key: string): boolean {
        return core.hasPresence(key);
      },
    };

    for (const primitive of primitives) {
      primitive.__validate?.(view);
      if (primitive.__livething === 'channel') {
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

  if (core.hooks.alarm.length > 0 || core.alarmSources.size > 0) {
    core.hooks.bootSchema.unshift(() => ensureAlarmCoordinatorSchema(core));
    core.hooks.boot.unshift(() => restoreAlarmCoordinator(core));
  }

  // Schema-init hooks (CREATE TABLE IF NOT EXISTS) run on every boot: a
  // capability added after storage was already initialized still needs its
  // tables created on the next wake, and repeating an IF-NOT-EXISTS
  // statement against tables that already exist is cheap.
  const storageForSchema = core.storage;
  if (core.hooks.bootSchema.length > 0) {
    const schemaState = storageForSchema ? readSchemaState(storageForSchema.sql) : { fresh: false };
    for (const hook of core.hooks.bootSchema) {
      await hook();
    }

    if (storageForSchema && schemaState.fresh) {
      markSchemaInitialized(storageForSchema.sql);
    }

    // A storage that has booted before may already hold membership rows, so
    // the first auto-rejoin must not be skipped.
    if (storageForSchema) core.freshBoot = schemaState.fresh;
  }

  for (const hook of core.hooks.boot) {
    await hook();
  }

  const initCtx = createHostContext(commonDeps(core));
  // Inbound onion: plugin inits run before the app's. Their
  // handlers are already wrapped in a plugin-scoped context.
  for (const entry of core.hooks.pluginLifecycle.init) {
    await withCallContext(core.asyncContext, { kind: 'init', getCtx: () => initCtx }, () =>
      entry.handler(initCtx),
    );
  }

  for (const hook of core.hooks.init) {
    await withCallContext(core.asyncContext, { kind: 'init', getCtx: () => initCtx }, () =>
      hook(initCtx),
    );
  }

  // Boot, init, and any capability setup may have created durable work after
  // their own hooks ran. Recompute the one adapter alarm from every source.
  accessDeps.rescheduleAlarm();
}

/** Adapter scheduled-callback entry. Runs `initialize` first, then walks scheduled hooks. */
export async function handleAlarm(core: EngineCore, accessDeps: EngineAccessDeps): Promise<void> {
  await initialize(core, accessDeps);
  beginAlarmDelivery(core);
  try {
    const failures: unknown[] = [];
    for (const hook of core.hooks.alarm) {
      try {
        await hook();
      } catch (error) {
        // One capability's durable cleanup must not starve another capability
        // that shares the adapter's single alarm. Keep running every hook so
        // successful sources can make progress; the engine schedules retries.
        failures.push(error);
      }
    }

    let retryAt: number | null = null;
    if (failures.length > 0) {
      const error =
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, '[livething] one or more durable alarm hooks failed');
      core.logger.error('[livething] durable alarm hook failed; retrying', {
        error: error instanceof Error ? error.message : String(error),
      });
      retryAt = Date.now() + ALARM_RETRY_DELAY_MS;
    }

    // A source may have removed its due work, while another source may still
    // have a future deadline. Include the framework retry in the same shared
    // calculation so a later retry cannot replace another source's earlier work.
    try {
      await rescheduleAlarm(core, { retryAt });
    } catch (retryError) {
      if (retryAt !== null) {
        core.logger.error('[livething] durable alarm retry could not be scheduled', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
      }

      throw retryError;
    }
  } finally {
    endAlarmDelivery(core);
  }
}
