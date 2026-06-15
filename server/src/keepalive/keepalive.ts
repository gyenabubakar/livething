import { assertPositiveInteger } from '~/_engine/validation.ts';
import type { Primitive } from '~/primitive.ts';

/** Options accepted by the keepalive primitive factory. Both are required. */
export interface KeepaliveOptions {
  /**
   * How often the server sends a keepalive `ping` text frame, in milliseconds.
   * The client answers with `pong`; that reply (like any inbound frame) proves
   * the connection is alive and resets the idle timer. Must be strictly less
   * than `idleTimeoutMs` so a quiet-but-alive client always answers in time.
   */
  readonly pingIntervalMs: number;

  /**
   * How long a connection may go without sending ANY frame before the engine
   * closes it, in milliseconds. Every inbound frame — an app message or the
   * automatic `pong` reply to the keepalive ping — resets this window. A
   * connection that has truly gone away sends nothing (not even a pong), so the
   * window elapses and it is closed.
   */
  readonly idleTimeoutMs: number;
}

/** The primitive type tag for the keepalive feature. */
export interface KeepalivePrimitive extends Primitive<'keepalive'> {
  /** How often the keepalive ping fires, in milliseconds. */
  readonly pingIntervalMs: number;
  /** Idle window before the connection is closed, in milliseconds. */
  readonly idleTimeoutMs: number;
}

/** Unique symbol used to enforce one keepalive registration per handler scope. */
const KEEPALIVE_KEY = Symbol('keepalive');

/**
 * Liveness check for a connection. The server sends a `ping` every
 * `pingIntervalMs`; a live client answers with `pong`. Any inbound frame (app
 * message or pong) resets an idle timer; when that timer reaches
 * `idleTimeoutMs` with nothing inbound, the engine closes the socket. The ping
 * exists so a quiet-but-alive client still produces a frame in time — so only a
 * connection that has actually gone away is closed.
 *
 * Both options are required and there are no defaults: `pingIntervalMs` must be
 * strictly less than `idleTimeoutMs`, or the ping could not land before the
 * idle window closes and live clients would be dropped. Enable this via
 * `keepalive: { pingIntervalMs, idleTimeoutMs }` on the contract config instead
 * of calling this primitive directly.
 */
export function keepalive(options: KeepaliveOptions): KeepalivePrimitive {
  assertPositiveInteger(options.pingIntervalMs, 'pingIntervalMs', 'keepalive()');
  assertPositiveInteger(options.idleTimeoutMs, 'idleTimeoutMs', 'keepalive()');
  if (options.pingIntervalMs >= options.idleTimeoutMs) {
    throw new Error(
      `[wskit] keepalive pingIntervalMs (${options.pingIntervalMs}) must be less than idleTimeoutMs ` +
        `(${options.idleTimeoutMs}): the keepalive ping has to fire before the idle window closes, ` +
        `or a live client would be dropped.`,
    );
  }

  return {
    __wskit: 'keepalive',
    __kind: 'infrastructure',
    __identity: [KEEPALIVE_KEY],
    __requires: {},
    pingIntervalMs: options.pingIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
    __setup(engine) {
      engine.installOnce(KEEPALIVE_KEY, () => {
        engine.setKeepalivePingInterval(options.pingIntervalMs);

        engine.onConnect((ctx) => {
          const connectionId = String((ctx as Record<PropertyKey, unknown>).id ?? '');
          if (!connectionId) return;
          engine.refreshConnectionIdleTimeout(connectionId, options.idleTimeoutMs);
        });

        engine.onConnectionActivity((connectionId) => {
          engine.refreshConnectionIdleTimeout(connectionId, options.idleTimeoutMs);
        });
      });
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
keepalive.__key = KEEPALIVE_KEY;
