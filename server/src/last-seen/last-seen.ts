import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { assertOneOf, assertPositiveInteger } from '~/_engine/validation.ts';
import {
  ensureLastSeenSchema,
  readLastSeen,
  readLastSeenMany,
  stampLastSeen,
} from '~/last-seen/storage.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { LastSeenService } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { LastSeenOptions, ResolvedLastSeenOptions } from '~/last-seen/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type produced by the `lastSeen()` capability. */
export interface LastSeenPrimitive extends Primitive<'last-seen'> {
  readonly options: ResolvedLastSeenOptions;
}

/** @internal */
const LAST_SEEN_KEY = Symbol('last-seen');

/** The default activity-stamp throttle window in milliseconds. */
const DEFAULT_LAST_SEEN_THROTTLE_MS = 60_000;

function resolveLastSeenOptions(config: LastSeenOptions): ResolvedLastSeenOptions {
  const track = config.track ?? 'connection';
  assertOneOf(track, ['connection', 'activity'] as const, {
    field: 'track',
    context: 'lastSeen()',
  });
  const throttleMs = config.throttleMs ?? DEFAULT_LAST_SEEN_THROTTLE_MS;
  assertPositiveInteger(throttleMs, 'throttleMs', 'lastSeen()');
  return { track, throttleMs };
}

/**
 * Track each user's last-seen timestamp in a durable table. Stamps on
 * connect and disconnect; in `activity` mode it also stamps on each real inbound
 * message — protocol frames and app events, but not transport keepalive pings —
 * throttled per user. Exposes `ctx.lastSeen` (`at` / `atMany` / `online`) and
 * fills the engine's `lastSeenService` slot so inbox backlog can read it without
 * importing this module.
 *
 * Enable it by listing the `lastSeen()` capability. Requires `persistence()`.
 */
export function lastSeen(config: LastSeenOptions = {}): LastSeenPrimitive {
  const options = resolveLastSeenOptions(config);

  return {
    __wskit: 'last-seen',
    __kind: 'infrastructure',
    __identity: [LAST_SEEN_KEY],
    __requires: {},
    __requiresCapabilities: [CAPABILITY_KIND.persistence],
    options,
    __setup(engine) {
      engine.installOnce(LAST_SEEN_KEY, () => {
        engine.setLastSeenService(buildLastSeenService(engine));

        engine.onBootSchema(() => {
          ensureLastSeenSchema(engine.storage.sql);
        });

        engine.extendContext(buildLastSeenContext(engine));

        engine.onConnect((ctx) => stampFromContext(engine, ctx));
        engine.onDisconnect((ctx) => stampFromContext(engine, ctx));

        if (options.track === 'activity') {
          registerActivityStamp(engine, options.throttleMs);
        }
      });
    },
  };
}

/** Build the engine's `lastSeenService` slot: a durable read plus an in-memory online check. */
function buildLastSeenService(engine: EngineAccess): LastSeenService {
  return {
    at(userId: string): number | null {
      return readLastSeen(engine.storage.sql, userId);
    },
    online(userId: string): boolean {
      return engine.isUserOnline(userId);
    },
  };
}

/** Build the `ctx.lastSeen` surface (at / atMany / online). */
function buildLastSeenContext(engine: EngineAccess) {
  return (): Record<string, unknown> => ({
    lastSeen: {
      at(userId: string): number | null {
        return readLastSeen(engine.storage.sql, userId);
      },
      atMany(userIds: string[]): Map<string, number> {
        return readLastSeenMany(engine.storage.sql, userIds);
      },
      online(userId: string): boolean {
        return engine.isUserOnline(userId);
      },
    },
  });
}

/** Stamp the connection's user, reading it off the internal connection marker. */
function stampFromContext(engine: EngineAccess, ctx: unknown): void {
  const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
    ENGINE_INTERNAL_CONNECTION
  ];
  const userId = connection?.userId ?? '';
  if (!userId) return;
  stampLastSeen(engine.storage.sql, { userId, now: Date.now() });
}

/**
 * Stamp on a real inbound message, at most once per `throttleMs` per user.
 * Uses message activity, not connection activity, so a keepalive ping on an
 * otherwise-idle connection does not keep bumping the mark. The per-user
 * last-stamp map lives in this closure for the engine's lifetime.
 */
function registerActivityStamp(engine: EngineAccess, throttleMs: number): void {
  const lastStampByUserId = new Map<string, number>();
  engine.onMessageActivity((connectionId) => {
    const userId = engine.getConnectionIdentity(connectionId);
    if (!userId) return;
    const now = Date.now();
    const previous = lastStampByUserId.get(userId);
    if (previous !== undefined && now - previous < throttleMs) return;
    lastStampByUserId.set(userId, now);
    stampLastSeen(engine.storage.sql, { userId, now });
  });
}

/** Symbol identity for dependency declarations. */
lastSeen.__key = LAST_SEEN_KEY;
