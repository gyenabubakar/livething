import { describe, expectTypeOf, it } from 'vitest';
import type { ProtocolPingsClient } from './handler.ts';

describe('protocol-pings client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('incoming');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('outgoing');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('requests');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('streams');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('namespaces');
    expectTypeOf<ProtocolPingsClient>().toHaveProperty('channels');
  });
});

describe('ProtocolPingsClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<ProtocolPingsClient['incoming']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['outgoing']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['requests']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['streams']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['channels']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['namespaces']>().not.toBeAny();
    expectTypeOf<ProtocolPingsClient['__errors__']>().not.toBeAny();
  });
});
