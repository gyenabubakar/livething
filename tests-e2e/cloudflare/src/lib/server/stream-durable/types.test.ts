import { describe, expectTypeOf, it } from 'vitest';
import type { StreamDurableClient } from './handler.ts';

describe('stream-durable client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<StreamDurableClient>().toHaveProperty('incoming');
    expectTypeOf<StreamDurableClient>().toHaveProperty('outgoing');
    expectTypeOf<StreamDurableClient>().toHaveProperty('requests');
    expectTypeOf<StreamDurableClient>().toHaveProperty('streams');
    expectTypeOf<StreamDurableClient>().toHaveProperty('resumableStreams');
    expectTypeOf<StreamDurableClient>().toHaveProperty('recordedStreams');
    expectTypeOf<StreamDurableClient>().toHaveProperty('namespaces');
    expectTypeOf<StreamDurableClient>().toHaveProperty('channels');
  });

  it('lists every declared durable stream by event name', () => {
    expectTypeOf<StreamDurableClient['recordedStreams']>().toHaveProperty('count-tokens');
    expectTypeOf<StreamDurableClient['recordedStreams']>().toHaveProperty('buffer-full-demo');
    expectTypeOf<StreamDurableClient['resumableStreams']>().toHaveProperty('paginate');
    expectTypeOf<StreamDurableClient['resumableStreams']>().toHaveProperty('attempt-stream');
  });

  it('each entry carries the contract slots a client SDK reads', () => {
    expectTypeOf<StreamDurableClient['recordedStreams']['count-tokens']>().toHaveProperty(
      'payload',
    );
    expectTypeOf<StreamDurableClient['recordedStreams']['count-tokens']>().toHaveProperty('chunk');
    expectTypeOf<StreamDurableClient['resumableStreams']['paginate']>().toHaveProperty('cursor');
  });
});
