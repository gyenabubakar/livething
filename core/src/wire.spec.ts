import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from './wire.ts';

describe('LiveThing wire codec', () => {
  it('always encodes the three-item tuple, including null metadata', () => {
    expect(encodeMessage({ event: 'hello', payload: null, metadata: null })).toBe(
      '["hello",null,null]',
    );
  });

  it('groups metadata on the wire', () => {
    expect(
      encodeMessage({
        event: 'message',
        payload: { text: 'hi' },
        metadata: {
          exchange: { id: 'exchange-1', source: 'client' },
          channel: { name: 'room' },
          delivery: { id: 'delivery-1' },
          stream: { id: 'stream-1', durability: 'persistent', seq: 4 },
        },
      }),
    ).toBe(
      '["message",{"text":"hi"},{"exchange":{"id":"exchange-1","source":"client"},"channel":{"name":"room"},"delivery":{"id":"delivery-1"},"stream":{"id":"stream-1","durability":"persistent","seq":4}}]',
    );
  });

  it('rejects object frames, tuples without metadata, and empty metadata', () => {
    expect(decodeMessage('{"event":"hello","payload":null}')).toBeNull();
    expect(decodeMessage('["hello",null]')).toBeNull();
    expect(decodeMessage('["hello",null,{}]')).toBeNull();
  });

  it('requires identifiers for channel and stream metadata groups', () => {
    expect(decodeMessage('["hello",null,{"channel":{}}]')).toBeNull();
    expect(decodeMessage('["hello",null,{"stream":{}}]')).toBeNull();
    expect(decodeMessage('["hello",null,{"exchange":{}}]')).toBeNull();
    expect(decodeMessage('["hello",null,{"delivery":{}}]')).toBeNull();
    expect(decodeMessage('["hello",null,{"channel":{"name":""}}]')).toBeNull();

    expect(decodeMessage('["hello",null,{"delivery":{"id":""}}]')).toBeNull();
  });

  it('does not encode invalid metadata objects', () => {
    expect(() => encodeMessage({ event: 'hello', payload: null, metadata: {} })).toThrow(
      'invalid LiveThing metadata',
    );
  });

  it('rejects unknown fields, wrong types, invalid enums, and unsafe sequences', () => {
    const invalidFrames = [
      '["hello",null,{"channel":{"name":"room","unknown":true}}]',
      '["hello",null,{"exchange":{"source":"worker"}}]',
      '["hello",null,{"delivery":{"seq":-1}}]',
      '["hello",null,{"delivery":{"seq":1.5}}]',
      '["hello",null,{"delivery":{"seq":9007199254740992}}]',
      '["hello",null,{"stream":{"id":"s1","durability":"temporary"}}]',
      '["hello",null,{"stream":{"id":"s1","terminated":"no"}}]',
    ];

    for (const frame of invalidFrames) expect(decodeMessage(frame)).toBeNull();
    expect(() =>
      encodeMessage({
        event: 'hello',
        payload: null,
        metadata: { delivery: { seq: -1 } },
      }),
    ).toThrow('invalid LiveThing metadata');
  });

  it('keeps delivery ids as message identity and stream durability nested', () => {
    const decoded = decodeMessage(
      '["message",null,{"delivery":{"id":"message-1"},"stream":{"id":"stream-1","durability":"ephemeral"}}]',
    );

    expect(decoded?.metadata).toEqual({
      delivery: { id: 'message-1' },
      stream: { id: 'stream-1', durability: 'ephemeral' },
    });
  });
});
