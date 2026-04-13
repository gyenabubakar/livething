/**
 * Side-effect import that adds `.heartbeat()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/heartbeat'`
 * Adds method: `.heartbeat(options)`
 *
 * Calling `.heartbeat({ timeout })` registers a keep-alive timer for every
 * connection. When a connection goes idle for longer than `timeout` milliseconds
 * without sending any message, the engine closes it automatically.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 *
 * Requires: `timers` platform capability.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { heartbeat as createHeartbeat } from '~/heartbeat/heartbeat.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { HeartbeatOptions, HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Module augmentation: adds `.heartbeat()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register a connection idle-timeout. The connection is closed automatically
     * when it has been silent for longer than `options.timeout` milliseconds.
     *
     * @param options.timeout Idle timeout in milliseconds.
     */
    heartbeat(options: HeartbeatOptions): ServerBuilder<NextState<TState, HeartbeatPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register a connection idle-timeout. The connection is closed automatically
     * when it has been silent for longer than `options.timeout` milliseconds.
     *
     * @param options.timeout Idle timeout in milliseconds.
     */
    heartbeat(options: HeartbeatOptions): GroupBuilder<NextState<TState, HeartbeatPrimitive>>;
  }
}

/** Runtime implementation of `.heartbeat()` for `ServerBuilder`. */
ServerBuilder.prototype.heartbeat = function (options: HeartbeatOptions) {
  this._primitives.push(createHeartbeat(options) as unknown as Primitive);
  return this;
};

/** Runtime implementation of `.heartbeat()` for `GroupBuilder`. */
GroupBuilder.prototype.heartbeat = function (options: HeartbeatOptions) {
  this._primitives.push(createHeartbeat(options) as unknown as Primitive);
  return this;
};

/** @internal Side-effect registration marker. */
export const __sideEffect_heartbeat = true;
