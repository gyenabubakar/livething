import * as EngineModule from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { AdapterConfig } from './types.ts';

/**
 * Define a platform adapter.
 *
 * The returned `serve()` passes a no-arg engine factory to the adapter's
 * `setup` function. Hibernation is resolved from the adapter config — either
 * a static boolean or a function of the serve options.
 *
 * Single-instance adapters (Node, Bun, Deno) call the factory once.
 * Per-instance adapters (Cloudflare DOs) call it in each constructor.
 */
export function defineServerAdapter<TOptions, TService>(config: AdapterConfig<TOptions, TService>) {
  return function serve(handler: ServerDefinition, options: TOptions): TService {
    const hibernation =
      typeof config.hibernation === 'function' ? config.hibernation(options) : config.hibernation;

    function createEngine() {
      return new EngineModule.Engine(handler, {
        adapterId: config.id,
        hibernation,
      });
    }

    return config.setup(createEngine, options);
  };
}
