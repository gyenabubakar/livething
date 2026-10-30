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

const DURABLE_STREAM_SERVICE_KEY = Symbol('livething.durableStreamService');

/** Installs the recorded-stream runtime: dispatch service, schema, orphan suspend, and purge. */
export const recordedDurableRegistrar = definePrimitive({
  tag: 'recorded-stream-runtime',
  key: Symbol('recorded-stream-runtime'),
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
