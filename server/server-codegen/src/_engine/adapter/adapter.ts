import { Engine } from '~/_engine/index.ts';
import type { ServerDefinition } from '~/define-server.ts';
import type { AdapterConfig } from './types.ts';

/**
 * Define a platform adapter.
 *
 * The returned `serve()` creates a fresh engine per handler and hands it to the
 * adapter setup function.
 */
export function defineServerAdapter<TOptions, TService>(config: AdapterConfig<TOptions, TService>) {
  return function serve(
    handler: ServerDefinition,
    options: TOptions,
  ): TService | Promise<TService> {
    const engine = new Engine(handler, {
      adapterId: config.id,
      hibernation: config.hibernation,
    });

    return config.setup(handler, engine, options);
  };
}
