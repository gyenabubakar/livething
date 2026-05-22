import { describe, expectTypeOf, it } from 'vitest';
import type { HeartbeatClient } from './handler.ts';

describe('heartbeat client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<HeartbeatClient>().toHaveProperty('incoming');
    expectTypeOf<HeartbeatClient>().toHaveProperty('outgoing');
    expectTypeOf<HeartbeatClient>().toHaveProperty('requests');
    expectTypeOf<HeartbeatClient>().toHaveProperty('streams');
    expectTypeOf<HeartbeatClient>().toHaveProperty('namespaces');
    expectTypeOf<HeartbeatClient>().toHaveProperty('channels');
  });
});

describe('HeartbeatClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<HeartbeatClient['incoming']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['outgoing']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['requests']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['streams']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['channels']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['namespaces']>().not.toBeAny();
    expectTypeOf<HeartbeatClient['__errors__']>().not.toBeAny();
  });
});
