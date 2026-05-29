import * as EngineModule from '~/_engine/engine.ts';
import type * as AdapterTypes from '~/_adapters/types.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { AdapterConfig } from './types.ts';

/**
 * Define a platform adapter that wraps a wskit server definition and returns
 * a platform-specific service.
 *
 * Implement the `setup` callback to wire your platform's WebSocket API into
 * the engine. The first argument to `setup` is a factory for the engine —
 * call it to get an engine instance to attach to.
 */
export function defineServerAdapter<TOptions, TService>(config: AdapterConfig<TOptions, TService>) {
  return function serve(handler: ServerDefinition, options: TOptions): TService {
    function createEngine(
      runtimeOptions: Omit<
        AdapterTypes.EngineOptions,
        'adapterId' | 'hibernation' | 'asyncContextFactory'
      >,
    ) {
      return new EngineModule.Engine(handler, {
        adapterId: config.id,
        hibernation: config.hibernation,
        asyncContextFactory: config.asyncContextFactory,
        ...runtimeOptions,
      });
    }

    return config.setup(createEngine, options);
  };
}
