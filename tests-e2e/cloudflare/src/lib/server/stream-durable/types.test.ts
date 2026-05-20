import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableClient } from './handler.ts';

describe('stream-durable client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamDurableClient>().toHaveProperty('incoming');
    expectTypeOf<StreamDurableClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamDurableClient>().toHaveProperty('requests');
    expectTypeOf<StreamDurableClient>().toHaveProperty('streams');
    expectTypeOf<StreamDurableClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamDurableClient>().toHaveProperty('channels');
  });

  it('every server-pushed stream surfaces under the single streams slot', () => {
    // Plain stream, resumableStream, recordedStream all collapse into one
    // client-facing slot. The client SDK does not care which durability
    // mechanism the server picked.
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('count-tokens');
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('buffer-full-demo');
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('paginate');
    expectTypeOf<StreamDurableClient['streams']>().toHaveProperty('attempt-stream');
  });

  it('each entry carries the contract slots a client SDK reads', () => {
    expectTypeOf<StreamDurableClient['streams']['count-tokens']>().toHaveProperty('payload');
    expectTypeOf<StreamDurableClient['streams']['count-tokens']>().toHaveProperty('chunk');
  });
});
