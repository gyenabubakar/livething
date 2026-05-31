import type * as EngineContextTypes from '~/_engine/contexts/types.ts';

/**
 * Persist connection state through the adapter's hibernation API so it
 * survives platform-level eviction. Adapters that don't support hibernation
 * simply pass `undefined` and the call no-ops.
 */
export function persistAttachment(
  connection: EngineContextTypes.RuntimeConnection,
  hibernationApi:
    | { persist(wsKey: unknown, snapshot: unknown): void; restore(wsKey: unknown): unknown }
    | undefined,
): void {
  if (!hibernationApi) return;
  const ephemeralTagPairs: { group: string; key: string }[] = [];
  for (const [group, keys] of connection.tags.ephemeral) {
    for (const key of keys) ephemeralTagPairs.push({ group, key });
  }
  hibernationApi.persist(connection.wsKey, {
    id: connection.id,
    meta: connection.meta,
    tags: ephemeralTagPairs,
    channelMemberships: [...connection.channelMemberships.values()],
    activeStreamIds: [...(connection.activeStreamIds ?? [])],
  });
}
