import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { heartbeat as createHeartbeat } from '~/heartbeat/heartbeat.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { HeartbeatOptions, HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { Primitive } from '~/primitive.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    heartbeat(options: HeartbeatOptions): ServerBuilder<NextState<TState, HeartbeatPrimitive>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    heartbeat(options: HeartbeatOptions): GroupBuilder<NextState<TState, HeartbeatPrimitive>>;
  }
}

ServerBuilder.prototype.heartbeat = function (options: HeartbeatOptions) {
  this._primitives.push(createHeartbeat(options) as unknown as Primitive);
  return this;
};

GroupBuilder.prototype.heartbeat = function (options: HeartbeatOptions) {
  this._primitives.push(createHeartbeat(options) as unknown as Primitive);
  return this;
};
