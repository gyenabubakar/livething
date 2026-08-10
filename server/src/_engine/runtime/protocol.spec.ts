import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  IncomingProtocolFrame,
  isProtocolEventName,
  OUTGOING_PROTOCOL_EVENT_NAMES,
  OutgoingProtocolFrame,
  parseUserEventFrame,
  UserEventFrameSchema,
  WSKitProtocolSchema,
} from './protocol.ts';

const CHANNEL_MAX = 256;
const ID_MAX = 128;

function parseFrame(frame: unknown) {
  return v.safeParse(UserEventFrameSchema, frame);
}

describe('wire-string length caps', () => {
  it('accepts an event name and routing ids within the caps', () => {
    const result = parseFrame({
      event: 'a'.repeat(ID_MAX),
      payload: { ok: true },
      __wskit: {
        channel: 'c'.repeat(CHANNEL_MAX),
        messageId: 'm'.repeat(ID_MAX),
        correlationId: 'r'.repeat(ID_MAX),
        streamId: 's'.repeat(ID_MAX),
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an over-long event name', () => {
    expect(parseFrame({ event: 'e'.repeat(ID_MAX + 1) }).success).toBe(false);
  });

  it('rejects an over-long channel name', () => {
    const result = parseFrame({
      event: 'go',
      __wskit: { channel: 'c'.repeat(CHANNEL_MAX + 1) },
    });
    expect(result.success).toBe(false);
  });

  it.each(['messageId', 'correlationId', 'streamId'])('rejects an over-long %s', (field) => {
    const result = parseFrame({ event: 'go', __wskit: { [field]: 'x'.repeat(ID_MAX + 1) } });
    expect(result.success).toBe(false);
  });

  it('caps streamId consistently between protocol frames and user-event __wskit', () => {
    // Regression: user-event __wskit.streamId must be capped at 128, the same
    // as protocol frames.
    const tooLong = v.safeParse(WSKitProtocolSchema, { streamId: 's'.repeat(ID_MAX + 1) });
    expect(tooLong.success).toBe(false);
    const ok = v.safeParse(WSKitProtocolSchema, { streamId: 's'.repeat(ID_MAX) });
    expect(ok.success).toBe(true);
  });

  it('still rejects an empty event name', () => {
    expect(parseFrame({ event: '' }).success).toBe(false);
  });
});

const OUTGOING_FRAME_SAMPLES: Record<string, unknown> = {
  __subscribeOk__: {
    event: '__subscribeOk__',
    payload: {},
    __wskit: { channel: 'room', source: 'client', channelPersistent: false },
  },
  __unsubscribeOk__: {
    event: '__unsubscribeOk__',
    payload: {},
    __wskit: { channel: 'room', unsubscribeId: 'unsub_1' },
  },
  __streamOk__: {
    event: '__streamOk__',
    payload: {},
    __wskit: { streamId: 's1', streamKind: 'ephemeral' },
  },
  __nudgeOk__: {
    event: '__nudgeOk__',
    payload: {},
    __wskit: { streamId: 's1', streamNudgeId: 'n1' },
  },
  __streamEnd__: {
    event: '__streamEnd__',
    payload: {},
    __wskit: { streamId: 's1', seq: 3, eventName: 'feed' },
  },
  __error__: {
    event: '__error__',
    payload: { code: 'forbidden', detail: { reason: 'no' } },
    __wskit: { channel: 'room', correlationId: 'c1', source: 'client' },
  },
  __kicked__: {
    event: '__kicked__',
    payload: { reason: 'spam' },
    __wskit: { channel: 'room' },
  },
  __memberJoin__: {
    event: '__memberJoin__',
    payload: { connectionId: 'c1', meta: { name: 'Ada' } },
    __wskit: { channel: 'room' },
  },
  __memberLeave__: {
    event: '__memberLeave__',
    payload: { connectionId: 'c1' },
    __wskit: { channel: 'room' },
  },
  __memberOnline__: {
    event: '__memberOnline__',
    payload: { connectionId: 'c1', meta: {} },
    __wskit: { channel: 'room' },
  },
  __memberOffline__: {
    event: '__memberOffline__',
    payload: { connectionId: 'c1' },
    __wskit: { channel: 'room' },
  },
  __memberSync__: {
    event: '__memberSync__',
    payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
    __wskit: { channel: 'room', source: 'server' },
  },
  __received__: {
    event: '__received__',
    payload: { identity: 'u1', receivedThrough: 5 },
    __wskit: { channel: 'room' },
  },
  __read__: {
    event: '__read__',
    payload: { identity: 'u1', readThrough: 3 },
    __wskit: { channel: 'room' },
  },
  __receivedQuery__: {
    event: '__receivedQuery__',
    payload: { identities: ['u1', 'u2'] },
    __wskit: { channel: 'room', correlationId: 'rq1' },
  },
  __readQuery__: {
    event: '__readQuery__',
    payload: { identities: ['u1', 'u2'] },
    __wskit: { channel: 'room', correlationId: 'rq2' },
  },
  __gap__: {
    event: '__gap__',
    payload: { missedThrough: 42 },
    __wskit: { channel: 'room' },
  },
};

describe('outgoing protocol-frame conformance', () => {
  it('has a sample for every event in OutgoingProtocolFrame', () => {
    expect(new Set(Object.keys(OUTGOING_FRAME_SAMPLES))).toEqual(
      new Set(OUTGOING_PROTOCOL_EVENT_NAMES),
    );
  });

  it.each(Object.entries(OUTGOING_FRAME_SAMPLES))(
    'round-trips %s through its schema',
    (_event, frame) => {
      const result = v.safeParse(OutgoingProtocolFrame, frame);
      expect(result.success).toBe(true);
    },
  );

  it('round-trips a member presence frame for a dynamic family (channelFamily set)', () => {
    const result = v.safeParse(OutgoingProtocolFrame, {
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: {} },
      __wskit: { channel: 'room:1', channelFamily: 'rooms' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty channelFamily marker', () => {
    const result = v.safeParse(UserEventFrameSchema, {
      event: 'send-message',
      payload: {},
      __wskit: { channel: 'room:1', channelFamily: '' },
    });
    expect(result.success).toBe(false);
  });
});

const INCOMING_RECEIPT_SAMPLES: Record<string, unknown> = {
  __received__: {
    event: '__received__',
    payload: { receivedThrough: 5 },
    __wskit: { channel: 'room' },
  },
  __read__: {
    event: '__read__',
    payload: { readThrough: 3 },
    __wskit: { channel: 'room' },
  },
  __receivedQuery__: {
    event: '__receivedQuery__',
    payload: { seq: 5 },
    __wskit: { channel: 'room', correlationId: 'rq1' },
  },
  __readQuery__: {
    event: '__readQuery__',
    payload: { seq: 5 },
    __wskit: { channel: 'room', correlationId: 'rq2' },
  },
};

describe('incoming receipt-frame conformance', () => {
  it.each(Object.entries(INCOMING_RECEIPT_SAMPLES))(
    'round-trips %s through the incoming schema',
    (_event, frame) => {
      const result = v.safeParse(IncomingProtocolFrame, frame);
      expect(result.success).toBe(true);
    },
  );
});

describe('protocol event detection', () => {
  it('detects protocol-shaped double-underscore names', () => {
    expect(isProtocolEventName('__subscribe__')).toBe(true);
    expect(isProtocolEventName('__e2e:feed::ping')).toBe(false);
    expect(isProtocolEventName('ping')).toBe(false);
  });
});

describe('parseUserEventFrame matches valibot exactly', () => {
  const valid: unknown[] = [
    { event: 'chat', payload: { text: 'hi' } },
    { event: 'chat' },
    { event: 'chat', payload: 'a string payload' },
    { event: 'chat', payload: [1, 2, 3] },
    { event: 'chat', payload: null },
    { event: 'e', payload: {}, __wskit: {} },
    { event: 'e', payload: {}, __wskit: { channel: 'room:1' } },
    { event: 'e', payload: {}, __wskit: { channel: 'room:1', channelFamily: 'room' } },
    { event: 'e', payload: {}, __wskit: { channel: 'room:1', channelFamily: null } },
    { event: 'e', payload: {}, __wskit: { messageId: 'm1', seq: 0 } },
    {
      event: 'a'.repeat(ID_MAX),
      payload: { a: 1 },
      __wskit: {
        correlationId: 'r1',
        source: 'client',
        channel: 'c'.repeat(CHANNEL_MAX),
        channelFamily: 'fam',
        streamId: 's1',
        streamKind: 'persistent',
        streamNudgeId: 'n1',
        streamTerminated: false,
        eventName: 'ev',
        messageId: 'm1',
        seq: 42,
      },
    },
  ];

  const invalid: unknown[] = [
    null,
    'not an object',
    42,
    [{ event: 'chat' }],
    {},
    { payload: {} },
    { event: '' },
    { event: 'a'.repeat(ID_MAX + 1) },
    { event: 123 },
    { event: 'chat', extra: 1 },
    { event: 'chat', __wskit: 'nope' },
    { event: 'chat', __wskit: ['nope'] },
    { event: 'chat', __wskit: { unknownKey: 1 } },
    { event: 'chat', __wskit: { channel: 'c'.repeat(CHANNEL_MAX + 1) } },
    { event: 'chat', __wskit: { channel: '' } },
    { event: 'chat', __wskit: { messageId: '' } },
    { event: 'chat', __wskit: { channelFamily: '' } },
    { event: 'chat', __wskit: { channelFamily: 'f'.repeat(ID_MAX + 1) } },
    { event: 'chat', __wskit: { seq: -1 } },
    { event: 'chat', __wskit: { seq: 1.5 } },
    { event: 'chat', __wskit: { seq: '3' } },
    { event: 'chat', __wskit: { source: 'nobody' } },
    { event: 'chat', __wskit: { streamKind: 'weird' } },
    { event: 'chat', __wskit: { streamTerminated: 'yes' } },
  ];

  it.each(valid.map((f, i) => [i, f]))('valid frame #%i parses identically', (_i, frame) => {
    expect(parseUserEventFrame(frame)).toEqual(v.parse(UserEventFrameSchema, frame));
  });

  it.each(invalid.map((f, i) => [i, f]))(
    'invalid frame #%i is rejected like valibot',
    (_i, frame) => {
      expect(v.safeParse(UserEventFrameSchema, frame).success).toBe(false);
      expect(() => parseUserEventFrame(frame)).toThrow();
    },
  );
});
