import { bench, describe } from 'vitest';
import { serializePayload } from './json-guard.ts';
import { serializeWireFrame, serializeWireFrameJson } from './wire-serialize.ts';

// The socket reads the whole frame text, which makes V8 flatten a string built by `+`. Each
// case does that read too, so the two builders are compared on the work a send really does.
function read(frame: string): number {
  return frame.charCodeAt(frame.length - 1);
}

const cases = {
  'request answer': {
    event: 'get-profile',
    payload: { userId: 'maya' },
    livething: { correlationId: 'request-42', source: 'client' },
  },
  'room message': {
    event: 'message',
    payload: { id: 'm_8f2a', text: 'hello', from: 'maya', sentAt: 1767225600000 },
    livething: {
      channel: 'room:general',
      channelFamily: 'rooms',
      deliverySeq: 12,
      messageId: 'm7',
    },
  },
  '2 KB message': {
    event: 'message',
    payload: { id: 'm_8f2a', text: 'x'.repeat(2000), from: 'maya', sentAt: 1767225600000 },
    livething: { channel: 'room:general', channelFamily: 'rooms' },
  },
};

for (const [name, { event, payload, livething }] of Object.entries(cases)) {
  describe(`wire frame · ${name}`, () => {
    bench('serialize, parse back, serialize the frame', () => {
      const json = serializePayload(event, payload);
      read(serializeWireFrame(event, JSON.parse(json), livething));
    });

    bench('serialize, then put the JSON into the frame', () => {
      const json = serializePayload(event, payload);
      read(serializeWireFrameJson(event, json, livething));
    });
  });
}
