import { assertValidHighWaterMark } from '~/_engine/compile/utils.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';

/**
 * Fields shared by every durable (resumable + recorded) stream config. Both
 * stream kinds keep a chunk alive across a disconnect and differ only in how
 * they replay it, so the disconnect/retention/broadcast knobs live here once and
 * each kind adds only what is unique to it (a `cursor`, a `maxChunks`).
 */
export interface CommonDurableStreamConfig {
  /** What happens to a running generator when the owning connection drops. */
  onDisconnect?: OnDisconnect;
  /** How long a suspended stream is kept after the owning connection drops. Default: 5 minutes. */
  maxAgeMs?: number;
  /** How long an ended stream is kept after `__streamEnd__` so a quick reconnect can still resume. Default: 30 seconds. */
  retentionAfterEndMs?: number;
  /**
   * One generator, many subscribers. The creator runs the generator once and
   * its chunks fan out to scope members; a non-creator `__streamCancel__`
   * unsubscribes only that peer while the stream keeps running for everyone
   * else. Scope follows where the stream is declared — top-level fans out to
   * every connection, inside `channel(...)` to that channel's members.
   * Default: false.
   */
  broadcast?: boolean;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()`. Defaults to 256 KB. */
  highWaterMark?: number;
}

/** Default lifetime/disconnect values applied to a durable stream config. */
export const DURABLE_STREAM_DEFAULTS = {
  onDisconnect: 'cancel-but-buffer',
  maxAgeMs: 5 * 60_000,
  retentionAfterEndMs: 30_000,
} as const;

/**
 * Run the shared build-time validation for a durable stream config. `recorded`
 * streams also carry a `maxChunks` bound; pass `{ maxChunks: true }` to check it.
 */
export function validateDurableStreamConfig(
  config:
    | {
        highWaterMark?: number;
        maxAgeMs?: number;
        retentionAfterEndMs?: number;
        maxChunks?: number;
        onDisconnect?: OnDisconnect;
      }
    | undefined,
  context: string,
  opts?: { maxChunks?: boolean },
): void {
  assertValidHighWaterMark(config?.highWaterMark, context);
  assertOptionalPositiveInteger(config?.maxAgeMs, 'maxAgeMs', context);
  assertOptionalPositiveInteger(config?.retentionAfterEndMs, 'retentionAfterEndMs', context);

  if (opts?.maxChunks) {
    assertOptionalPositiveInteger(config?.maxChunks, 'maxChunks', context);
  }

  if (config?.onDisconnect !== undefined) {
    assertOneOf(config.onDisconnect, ['cancel-but-buffer', 'keep-running'] as const, {
      field: 'onDisconnect',
      context,
    });
  }
}
