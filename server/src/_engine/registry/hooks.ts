import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

/** Build the empty hook registries the engine fills during primitive setup. */
export function createRegisteredHooks(): EngineRuntimeTypes.RegisteredEngineHooks {
  return {
    activity: [],
    incoming: [],
    outgoing: [],
    beforeSend: [],
    afterSend: [],
    protocol: new Map(),
    contextExtenders: [],
    boot: [],
    init: [],
    connect: [],
    disconnect: [],
    shutdown: [],
    error: [],
    upgrade: [],
    builderUpgrade: undefined,
    binary: [],
    validationError: [],
    alarm: [],
    beforeSubscribe: new Map(),
    subscribe: new Map(),
    unsubscribe: new Map(),
    sessionEnd: new Map(),
  };
}
