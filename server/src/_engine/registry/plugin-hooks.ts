/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { scheduled as createScheduled } from '~/scheduled/scheduled.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as DefinePlugin from '~/plugins/define.ts';

type AnyScheduled = EngineCompileTypes.AnyScheduled;
type PluginRuntime = EngineRuntimeTypes.PluginRuntime;

/**
 * Build the hook surface passed to one plugin's setup function. Smaller than
 * `EngineAccess` — plugins can only register lifecycle and message hooks.
 */
export function createPluginHooks(
  core: EngineCore,
  runtime: PluginRuntime,
  ensureScheduledRuntime: () => void,
): DefinePlugin.PluginHooks<any> {
  return {
    onIncoming: (handler) => {
      runtime.onIncoming = handler;
    },
    onOutgoing: (handler) => {
      runtime.onOutgoing = handler;
    },
    onInit: (handler) => {
      runtime.onInit = handler;
    },
    onConnect: (handler) => {
      runtime.onConnect = handler;
    },
    onDisconnect: (handler) => {
      runtime.onDisconnect = handler;
    },
    onShutdown: (handler) => {
      runtime.onShutdown = handler;
    },
    scheduled: (name: string, handler) => {
      const taskId = `__${runtime.instance.id}:${name}`;
      if (core.compiled.scheduled.has(taskId)) {
        throw new Error(
          `[wskit] Plugin "${runtime.instance.id}" registered scheduled task "${name}" more than once. ` +
            `Each task name can only be wired by one hooks.scheduled(...) call per setup().`,
        );
      }
      // The declaration in `definitions: [scheduled(name, { data, every, retry })]`
      // is the single source of config. Look it up by name and apply its
      // options when building the runtime primitive — hooks.scheduled is now
      // just a body attachment, no builder.
      const declared = runtime.instance.scheduled.find((s) => s.name === name) as
        | { declaration?: { data?: unknown; every?: number; retry?: unknown } }
        | undefined;
      if (!declared) {
        throw new Error(
          `[wskit] Plugin "${runtime.instance.id}" hooks.scheduled("${name}", ...) has no matching declaration. ` +
            `Add scheduled("${name}", { ... }) to the plugin's definitions array.`,
        );
      }
      const decl = declared.declaration ?? {};
      core.compiled.scheduled.set(
        taskId,
        createScheduled(taskId, (b) => {
          let chain: any = b;
          if (decl.data !== undefined) chain = chain.data(decl.data);
          if (decl.retry !== undefined) chain = chain.retry(decl.retry);
          if (decl.every !== undefined) chain = chain.every(decl.every);
          return chain.run(handler);
        }) as AnyScheduled,
      );
      ensureScheduledRuntime();
      return { id: taskId };
    },
    generateId: (prefix?: string) => core.generateId(prefix),
    getState: () => {
      const activeId = core.asyncContext.getStore()?.connectionId;
      const connection = activeId ? core.connections.get(activeId) : undefined;

      return connection
        ? EngineContexts.toConnectionInfo(connection, core.engineInstanceId)
        : {
            id: '',
            identity: '',
            meta: {},
            tags: [],
            channels: [],
            latency: null,
            quality: 'good',
            bufferedAmount: 0,
            ref: () => EngineContexts.buildConnectionRef('', '', core.engineInstanceId),
          };
    },
  };
}
