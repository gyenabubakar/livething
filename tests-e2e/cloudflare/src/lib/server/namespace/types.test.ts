import { describe, expectTypeOf, it } from 'vitest';
import type { NamespaceClient } from './handler.ts';

describe('namespace client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<NamespaceClient>().toHaveProperty('incoming');
    expectTypeOf<NamespaceClient>().toHaveProperty('outgoing');
    expectTypeOf<NamespaceClient>().toHaveProperty('requests');
    expectTypeOf<NamespaceClient>().toHaveProperty('streams');
    expectTypeOf<NamespaceClient>().toHaveProperty('resumableStreams');
    expectTypeOf<NamespaceClient>().toHaveProperty('recordedStreams');
    expectTypeOf<NamespaceClient>().toHaveProperty('namespaces');
    expectTypeOf<NamespaceClient>().toHaveProperty('channels');
  });
});
