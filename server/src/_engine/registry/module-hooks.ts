/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { scheduled as createScheduled } from '~/scheduled/scheduled.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as DefineModule from '~/modules/define.ts';

type AnyScheduled = EngineCompileTypes.AnyScheduled;
type ModuleRuntime = EngineRuntimeTypes.ModuleRuntime;

/**
 * Build the hook surface passed to one module's setup function. Smaller than
 * `EngineAccess` — modules can only register lifecycle and message hooks.
 */
export function createModuleHooks(
  core: EngineCore,
  runtime: ModuleRuntime,
  ensureScheduledRuntime: () => void,
): DefineModule.ModuleHooks<any> {
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
      const connection = core.activeConnectionId
        ? core.connections.get(core.activeConnectionId)
        : undefined;

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
