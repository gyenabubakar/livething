import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  OUTGOING_PROTOCOL_EVENT_NAMES,
  OutgoingProtocolFrame,
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
    // Regression: user-event __wskit.streamId used to be unbounded while the
    // protocol frames capped it at 128.
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

  it('round-trips a member presence frame for a dynamic family (channelScope set)', () => {
    const result = v.safeParse(OutgoingProtocolFrame, {
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: {} },
      __wskit: { channel: 'room:1', channelScope: 'rooms' },
    });
    expect(result.success).toBe(true);
  });
});
