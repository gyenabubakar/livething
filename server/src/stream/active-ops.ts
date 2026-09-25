import { bufferStreamNudge, cancelStream, stopChannelStreams } from '~/stream/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';

/**
 * Nudge buffering, active-stream cancel, and the channel-leave stop are shared
 * by plain and durable streams — all drive the same in-memory active-stream map.
 * Whichever stream kind is listed registers these ops, so the registration is
 * guarded by `installOnce` to land exactly once even when several kinds are
 * listed.
 *
 * Importing only these functions keeps `runStream` out of a durable-only
 * bundle: a handler that lists `recordedStream` but not `stream` never pulls the
 * plain-stream engine.
 */
const ACTIVE_STREAM_OPS_KEY = Symbol('livething.activeStreamOps');

export function registerActiveStreamOps(engine: EngineAccess): void {
  engine.installOnce(ACTIVE_STREAM_OPS_KEY, () => {
    engine.setActiveStreamOps(bufferStreamNudge, cancelStream, stopChannelStreams);
  });
}
