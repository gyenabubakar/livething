import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from './wire.ts';

describe('LiveThing wire codec', () => {
  it('reads and writes the upload metadata group: an id, and a seq or a size', () => {
    const start = [
      'upload-attachment',
      { attachmentId: 'att_1' },
      { upload: { id: 'up-1', size: 20 } },
    ];
    const piece = ['upload-attachment', null, { upload: { id: 'up-1', seq: 3 } }];
    for (const frame of [start, piece]) {
      expect(decodeMessage(JSON.stringify(frame))).toEqual({
        event: frame[0],
        payload: frame[1],
        metadata: frame[2],
      });
    }

    expect(
      encodeMessage({
        event: '__uploadEnd__',
        payload: { totalBytes: 20 },
        metadata: { upload: { id: 'up-1' } },
      }),
    ).toBe('["__uploadEnd__",{"totalBytes":20},{"upload":{"id":"up-1"}}]');
  });

  it.each([
    ['no id', { seq: 1 }],
    ['an empty id', { id: '' }],
    ['an unknown key', { id: 'up-1', offset: 0 }],
    ['a negative seq', { id: 'up-1', seq: -1 }],
    ['a size that is not a whole number', { id: 'up-1', size: 1.5 }],
    ['both a seq and a size', { id: 'up-1', seq: 1, size: 5 }],
  ])('rejects upload metadata with %s', (_name, upload) => {
    expect(decodeMessage(JSON.stringify(['upload-attachment', null, { upload }]))).toBeNull();
  });

  it('refuses to encode upload metadata with both a seq and a size', () => {
    expect(() =>
      encodeMessage({
        event: 'upload-attachment',
        payload: null,
        metadata: { upload: { id: 'up-1', seq: 1, size: 5 } },
      }),
    ).toThrow('invalid LiveThing metadata');
  });

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
