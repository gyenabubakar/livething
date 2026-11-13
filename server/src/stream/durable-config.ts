import { assertOptionalPositiveInteger } from '~/_engine/validation.ts';

type ValidateDurableStreamConfigOptsParameter = { maxChunks?: boolean };

/** The retention and broadcast fields of a recorded stream config. */
export interface CommonDurableStreamConfig {
  /**
   * How long a stream whose generator stopped mid-stream (for example after a
   * server restart) is kept, so a reconnecting client can still replay its
   * chunks and learn it was interrupted. Default: 5 minutes.
   */
  maxAgeMs?: number;
  /** How long an ended stream is kept after `__streamEnd__` so a quick reconnect can still continue. Default: 30 seconds. */
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
}

/** Default lifetime values applied to a recorded stream config. */
export const DURABLE_STREAM_DEFAULTS = {
  maxAgeMs: 5 * 60_000,
  retentionAfterEndMs: 30_000,
} as const;

/**
 * Run the build-time validation for a recorded stream config. Pass
 * `{ maxChunks: true }` to also check the buffer bounds, `maxChunks` and `maxBufferBytes`.
 */
export function validateDurableStreamConfig(
  config:
    | {
        maxAgeMs?: number;
        retentionAfterEndMs?: number;
        maxChunks?: number;
        maxBufferBytes?: number;
      }
    | undefined,
  context: string,
  opts?: ValidateDurableStreamConfigOptsParameter,
): void {
  assertOptionalPositiveInteger(config?.maxAgeMs, 'maxAgeMs', context);
  assertOptionalPositiveInteger(config?.retentionAfterEndMs, 'retentionAfterEndMs', context);

  if (opts?.maxChunks) {
    assertOptionalPositiveInteger(config?.maxChunks, 'maxChunks', context);
    assertOptionalPositiveInteger(config?.maxBufferBytes, 'maxBufferBytes', context);
  }
}
