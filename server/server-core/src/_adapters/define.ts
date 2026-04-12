import * as EngineModule from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { AdapterConfig } from './types.ts';

/**
 * Define a platform adapter.
 *
 * The returned `serve()` passes an engine factory to the adapter's `setup`
 * function. The factory creates a configured `Engine` each time it is called.
 *
 * Single-instance adapters (Node, Bun, Deno) call the factory once.
 * Per-instance adapters (Cloudflare DOs) call it in each constructor.
 */
export function defineServerAdapter<TOptions, TService>(
  config: AdapterConfig<TOptions, TService>,
) {
  return function serve(
    handler: ServerDefinition,
    options: TOptions,
  ): TService {
    const createEngine = () =>
      new EngineModule.Engine(handler, {
        adapterId: config.id,
        hibernation: config.hibernation,
      });

    return config.setup(createEngine, options);
  };
}
