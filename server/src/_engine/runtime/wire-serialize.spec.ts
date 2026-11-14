import { describe, expect, it } from 'vitest';
import { serializePayload } from './json-guard.ts';
import { serializeWireFrame, serializeWireFrameJson } from './wire-serialize.ts';

// The send path puts the payload's JSON text into the frame instead of parsing it and
// serializing it again, so the two builders must give the same string.
describe('serializeWireFrameJson', () => {
  const payloads: Record<string, unknown>[] = [
    { text: 'hello', from: 'maya' },
    { emoji: '🎉', quote: 'say "hi"\n', slash: '</script>', lone: '\ud800' },
    { 10: 'ten', b: 1, 2: 'two', a: [1, -0, 1e21, 0.1] },
    { nested: { list: [{ id: 'm1' }, null, true] }, ['__proto__']: { kept: true } },
    { at: new Date(1767225600000) },
    { toJSON: () => ({ shown: 'from toJSON' }) },
    {},
  ];
  const metadata = [
    undefined,
    { channel: 'room:general', channelFamily: 'rooms', deliverySeq: 7, messageId: 'message-7' },
    { correlationId: 'request-42', source: 'client' },
  ];

  for (const [index, payload] of payloads.entries()) {
    for (const livething of metadata) {
      it(`builds the same frame as serializeWireFrame (payload ${index})`, () => {
        const json = serializePayload('message', payload);

        expect(serializeWireFrameJson('message', json, livething)).toBe(
          serializeWireFrame('message', JSON.parse(json), livething),
        );
      });
    }
  }

  it('sends a protocol event with an empty payload as null, like serializeWireFrame', () => {
    expect(serializeWireFrameJson('__subscribeOk__', '{}', { channel: 'room' })).toBe(
      serializeWireFrame('__subscribeOk__', {}, { channel: 'room' }),
    );
    expect(serializeWireFrameJson('__subscribeOk__', '{}')).toBe('["__subscribeOk__",null,null]');
  });

  it('keeps an empty payload of an app event', () => {
    expect(serializeWireFrameJson('typing', '{}')).toBe('["typing",{},null]');
  });

  it('writes a null payload as null', () => {
    expect(serializeWireFrameJson('history-cleared', 'null')).toBe(
      serializeWireFrame('history-cleared', null),
    );
  });
});
