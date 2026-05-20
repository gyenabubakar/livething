import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableScopedClient } from './handler.ts';

describe('stream-durable-scoped client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('incoming');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('requests');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('streams');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamDurableScopedClient>().toHaveProperty('channels');
  });
});
