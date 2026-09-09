/**
 * Stable identity tokens for capabilities. A factory and the capability it
 * produces share the same token, so requirement resolution — the presence
 * resolver (`resolveCapabilityRequirements`) and a plugin's `dependsOn` (see
 * `assertPluginDependencies`) — can match a referenced capability to a listed
 * one by identity, without calling the factory and without colliding on shape.
 *
 * The three stream variants get distinct kinds so a recorded/resumable
 * requirement is never satisfied by a plain `stream()`. Replay uses a single
 * `replay` kind for history and snapshot (they are the same engine);
 * `replay.custom` is a distinct engine and gets its own `replay-custom` kind.
 */
export const CAPABILITY_KIND = {
  dedup: 'dedup',
  sequence: 'sequence',
  keepalive: 'keepalive',
  rateLimit: 'rate-limit',
  replay: 'replay',
  replayCustom: 'replay-custom',
  inbox: 'inbox',
  readReceipts: 'read-receipts',
  lastSeen: 'last-seen',
  clientRequests: 'client-requests',
  serverRequests: 'server-requests',
  scheduled: 'scheduled',
  channels: 'channels',
  tags: 'tags',
  emits: 'emits',
  errors: 'errors',
  intercepts: 'intercepts',
  stream: 'stream',
  resumableStream: 'resumable-stream',
  recordedStream: 'recorded-stream',
} as const;

/** A capability identity token. @internal */
export type CapabilityKind = (typeof CAPABILITY_KIND)[keyof typeof CAPABILITY_KIND];

/**
 * The capability kinds a plugin can never own (the global host-owned engines —
 * they carry `__hostOnly`). When a primitive declares one of these as a
 * required capability, a plugin cannot satisfy it itself, so the requirement
 * is recorded as a host dependency instead. @internal
 */
export const HOST_ONLY_CAPABILITY_KINDS: ReadonlySet<string> = new Set([
  CAPABILITY_KIND.dedup,
  CAPABILITY_KIND.sequence,
  CAPABILITY_KIND.keepalive,
  CAPABILITY_KIND.rateLimit,
  CAPABILITY_KIND.replay,
]);

/**
 * The capability kinds that can never appear at the host or plugin top level —
 * `inbox()` and `readReceipts()`, which only exist inside a channel's own
 * `capabilities` list. Backs the runtime gate that matches the compile-time
 * `__channelOnly` brand. @internal
 */
export const CHANNEL_ONLY_CAPABILITY_KINDS: ReadonlySet<string> = new Set([
  CAPABILITY_KIND.inbox,
  CAPABILITY_KIND.readReceipts,
]);

/** Reverse lookup from a kind token to the factory name that produces it. @internal */
const KIND_TO_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CAPABILITY_KIND).map((entry) => [entry[1], entry[0]]),
);
const CAPABILITY_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  [CAPABILITY_KIND.replayCustom]: 'replay.custom',
};

/** Render a kind token as the capability factory call to show in an error. @internal */
export function capabilityDisplayName(kind: string): string {
  return `${CAPABILITY_DISPLAY_NAMES[kind] ?? KIND_TO_NAME[kind] ?? kind}()`;
}
