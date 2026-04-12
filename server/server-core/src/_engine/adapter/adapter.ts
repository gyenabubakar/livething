import * as EngineModule from '~/_engine/engine.ts';
import type * as DefineServer from '~/server-definition.ts';
import type * as EngineAdapterTypes from './types.ts';

/**
 * Define a platform adapter.
 *
 * The returned `serve()` creates a fresh engine per handler and hands it to the
 * adapter setup function.
 */
export function defineServerAdapter<TOptions, TService>(
  config: EngineAdapterTypes.AdapterConfig<TOptions, TService>,
) {
  return function serve(
    handler: DefineServer.ServerDefinition,
    options: TOptions,
  ): TService | Promise<TService> {
    const engine = new EngineModule.Engine(handler, {
      adapterId: config.id,
      hibernation: config.hibernation,
    });

    return config.setup(handler, engine, options);
  };
}
