import { registerScheduledService } from '~/_engine/scheduling.ts';
import { definePrimitive } from '~/primitive.ts';
import { registerActiveStreamOps } from '~/stream/active-ops.ts';
import { durableStreamService } from './dispatch.ts';

/**
 * Both `resumableStream()` and `recordedStream()` share one durable-stream
 * runtime, so the service is registered through `installOnce` and lands a single
 * time even when both capabilities are listed. Each capability still gets its own
 * registrar primitive (distinct keys) so listing both never collides.
 */
const DURABLE_STREAM_SERVICE_KEY = Symbol('wskit.durableStreamService');

function makeDurableRegistrar(tag: string, key: symbol) {
  return definePrimitive({
    tag,
    key,
    kind: 'infrastructure',
    create: () => ({}),
    setup(engine) {
      engine.installOnce(DURABLE_STREAM_SERVICE_KEY, () => {
        engine.setDurableStreamService(durableStreamService);
      });
      registerActiveStreamOps(engine);
      registerScheduledService(engine);
    },
  });
}

export const resumableDurableRegistrar = makeDurableRegistrar(
  'resumable-stream-runtime',
  Symbol('resumable-stream-runtime'),
);

export const recordedDurableRegistrar = makeDurableRegistrar(
  'recorded-stream-runtime',
  Symbol('recorded-stream-runtime'),
);
