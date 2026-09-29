import { registerScheduledService } from '~/_engine/scheduling.ts';
import { definePrimitive } from '~/primitive.ts';
import { registerActiveStreamOps } from '~/stream/active-ops.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { PurgeUserOptions } from '~/_engine/runtime/purge-user.ts';
import { durableStreamService } from './dispatch.ts';
import {
  ensureDurableStreamSchema,
  purgeStreamsByUser,
  suspendOrphanedStreams,
} from './storage.ts';

/**
 * Both `cursorStream()` and `recordedStream()` share one durable-stream
 * runtime, so the service is registered through `installOnce` and lands a single
 * time even when both capabilities are listed. Each capability still gets its own
 * registrar primitive (distinct keys) so listing both never collides.
 */
const DURABLE_STREAM_SERVICE_KEY = Symbol('livething.durableStreamService');

function makeDurableRegistrar(tag: string, key: symbol) {
  return definePrimitive({
    tag,
    key,
    kind: 'infrastructure',
    create: () => ({}),
    setup(engine) {
      engine.installOnce(DURABLE_STREAM_SERVICE_KEY, () => {
        engine.setDurableStreamService(durableStreamService);

        engine.onBootSchema(() => {
          ensureDurableStreamSchema(engine.storage.sql);
          suspendOrphanedStreams(engine.storage.sql, Date.now());
        });

        engine.onPurgeUser((core, userId, options?: PurgeUserOptions) => {
          purgeStreamsByUser((core as EngineCore).storage.sql, userId, options);
        });
      });
      registerActiveStreamOps(engine);
      registerScheduledService(engine);
    },
  });
}

export const cursorDurableRegistrar = makeDurableRegistrar(
  'cursor-stream-runtime',
  Symbol('cursor-stream-runtime'),
);

export const recordedDurableRegistrar = makeDurableRegistrar(
  'recorded-stream-runtime',
  Symbol('recorded-stream-runtime'),
);
