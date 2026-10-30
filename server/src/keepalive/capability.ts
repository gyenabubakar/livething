import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { keepalive as keepaliveFactory } from '~/keepalive/keepalive.ts';
import type { KeepaliveOptions } from '~/keepalive/keepalive.ts';

/**
 * Send periodic pings so the server can detect and close dead connections.
 *
 * Defaults: `pingIntervalMs` 30 s, `idleTimeoutMs` 60 s. `pingIntervalMs` must
 * be less than `idleTimeoutMs`: the ping has to fire before the idle window
 * closes, or a quiet-but-alive client would be dropped.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { keepalive } from '@livething/server/keepalive';
 *
 * const base = server({
 *   capabilities: [keepalive()],
 * });
 * ```
 */
export const keepalive = defineHostCapability(
  CAPABILITY_KIND.keepalive,
  (options?: KeepaliveOptions) => keepaliveFactory(options),
);
