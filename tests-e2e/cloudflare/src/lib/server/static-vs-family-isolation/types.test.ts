import { describe, expectTypeOf, it } from 'vitest';
import type { StaticVsFamilyIsolationClient } from './handler.ts';

describe('static-vs-family-isolation client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('incoming');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('outgoing');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('requests');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('streams');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('resumableStreams');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('recordedStreams');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('namespaces');
    expectTypeOf<StaticVsFamilyIsolationClient>().toHaveProperty('channels');
  });
});
