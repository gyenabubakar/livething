import { hostCapability } from '~/_define/capability.ts';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import { keepalive as keepaliveFactory } from '~/keepalive/keepalive.ts';
import type { HostCapability } from '~/_define/capability.ts';
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
 *   env: t<Env>(),
 *   capabilities: [keepalive({ pingIntervalMs: 30_000, idleTimeoutMs: 60_000 })],
 * });
 * ```
 */
export function keepalive(options: KeepaliveOptions): HostCapability<{}, 'keepalive'> {
  const { pingIntervalMs, idleTimeoutMs } = options;
  assertPositiveInteger(pingIntervalMs, 'pingIntervalMs', 'keepalive()');
  assertPositiveInteger(idleTimeoutMs, 'idleTimeoutMs', 'keepalive()');
  if (pingIntervalMs >= idleTimeoutMs) {
    throw new Error(
      `[wskit] keepalive.pingIntervalMs (${pingIntervalMs}) must be less than ` +
        `keepalive.idleTimeoutMs (${idleTimeoutMs}): the ping has to fire before the idle ` +
        'window closes, or a live client would be dropped.',
    );
  }
  return hostCapability<{}, 'keepalive'>([keepaliveFactory(options)], ['keepalive']);
}
