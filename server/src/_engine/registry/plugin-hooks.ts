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
    scheduled: (name: string, callback) => {
      const taskId = `__${runtime.instance.id}:${name}`;
      core.compiled.scheduled.set(taskId, createScheduled(taskId, callback) as AnyScheduled);
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
