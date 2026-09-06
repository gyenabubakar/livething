import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { keepalive as keepaliveFactory } from '~/keepalive/keepalive.ts';
import type { KeepaliveOptions } from '~/keepalive/keepalive.ts';

/**
 * Send periodic pings so the server can detect and close dead connections.
 *
 * `pingIntervalMs` must be less than `idleTimeoutMs`: the ping has to fire
 * before the idle window closes, or a quiet-but-alive client would be dropped.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { keepalive } from '@wskit/server/keepalive';
 *
 * const base = define({
 *   capabilities: [keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: 60_000 })],
 * });
 * ```
 */
export const keepalive = defineHostCapability(
  CAPABILITY_KIND.keepalive,
  (options: KeepaliveOptions) => keepaliveFactory(options),
);
