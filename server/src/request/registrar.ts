/* oxlint-disable @typescript-eslint/no-explicit-any */
import { sendThroughPipeline } from '~/outgoing/runtime.ts';
import { definePrimitive } from '~/primitive.ts';
import { handleRequest } from '~/request/runtime.ts';

const REQUEST_RUNTIME_KEY = Symbol('request-runtime');

/**
 * Registers the request dispatcher so the engine's message hub can run a matched
 * `request(...)` handler without importing the request runtime. The runtime bag
 * the hub passes already carries everything `handleRequest` needs.
 */
export const requestRuntimePrimitive = definePrimitive({
  tag: 'request-runtime',
  key: REQUEST_RUNTIME_KEY,
  setup(engine) {
    engine.setRequestDispatch((runtime: any, _connection, options) =>
      handleRequest(
        {
          asyncContext: runtime.asyncContext,
          logger: runtime.logger,
          sendThroughPipeline: (connection, opts) => sendThroughPipeline(runtime, connection, opts),
        },
        options as any,
      ),
    );
  },
});
