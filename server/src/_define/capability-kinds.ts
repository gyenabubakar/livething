/**
 * Stable identity tokens for every capability that can be a plugin `dependsOn`
 * target. A factory and the capability it produces share the same token, so the
 * `dependsOn` matcher (see `assertPluginDependencies` in `plugin.ts`) can compare
 * a `dependsOn` factory ref against the host's listed capabilities by identity —
 * without calling the factory and without colliding on shape.
 *
 * The three stream variants get distinct kinds so `dependsOn: [resumableStream]`
 * is never satisfied by a host that lists only `stream()`. Replay uses a single
 * `replay` kind for history and snapshot (they are the same engine); `replay.custom`
 * is a distinct engine and gets its own `replay-custom` kind.
 */
export const CAPABILITY_KIND = {
  ack: 'ack',
  dedup: 'dedup',
  sequence: 'sequence',
  keepalive: 'keepalive',
  persistence: 'persistence',
  rateLimit: 'rate-limit',
  replay: 'replay',
  replayCustom: 'replay-custom',
  requests: 'requests',
  scheduled: 'scheduled',
  channels: 'channels',
  tags: 'tags',
  emits: 'emits',
  errors: 'errors',
  stream: 'stream',
  resumableStream: 'resumable-stream',
  recordedStream: 'recorded-stream',
} as const;

/** A capability identity token. @internal */
export type CapabilityKind = (typeof CAPABILITY_KIND)[keyof typeof CAPABILITY_KIND];
