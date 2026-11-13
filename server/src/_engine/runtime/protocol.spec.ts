import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  MAX_RESUME_TOKENS,
  metadataFromLiveThing,
  MetadataSchema,
  OutgoingProtocolFrame,
  parseUserEventFrame,
  ReadFrame,
  ReplayFrame,
  serializeWireFrame,
  SubscribeOkFrame,
  UserEventFrameSchema,
} from './protocol.ts';

describe('upload metadata', () => {
  it('reads an upload id, seq and size, and writes them back', () => {
    const frame = parseUserEventFrame([
      'upload-attachment',
      null,
      { upload: { id: 'up-1', seq: 2 } },
    ]);
    expect(frame.__livething).toMatchObject({ uploadId: 'up-1', uploadSeq: 2 });
    expect(metadataFromLiveThing({ uploadId: 'up-1', uploadSize: 20 })).toEqual({
      upload: { id: 'up-1', size: 20 },
    });
  });

  it('refuses upload metadata with an unknown key, a bad seq, or both a seq and a size', () => {
    for (const upload of [
      { id: 'up-1', offset: 0 },
      { id: 'up-1', seq: -1 },
      { seq: 1 },
      { id: 'up-1', seq: 1, size: 5 },
    ]) {
      expect(() => parseUserEventFrame(['upload-attachment', null, { upload }])).toThrow();
    }
  });

  it('parses __uploadEnd__ and __uploadCancel__, and the acks and the reply the server sends', () => {
    expect(() =>
      v.parse(OutgoingProtocolFrame, [
        '__uploadAck__',
        { receivedThrough: 8, savedThrough: 0, pieceBytes: 8, windowBytes: 16 },
        { upload: { id: 'up-1' } },
      ]),
    ).not.toThrow();
    expect(() =>
      v.parse(OutgoingProtocolFrame, [
        '__uploadDone__',
        { info: null },
        { upload: { id: 'up-1' } },
      ]),
    ).not.toThrow();
    expect(() =>
      v.parse(OutgoingProtocolFrame, [
        '__uploadAck__',
        { receivedThrough: 8 },
        { upload: { id: 'up-1' } },
      ]),
    ).toThrow();
  });
});

describe('LiveThing wire tuples', () => {
  it('always serializes exactly three elements', () => {
    expect(JSON.parse(serializeWireFrame('ping', undefined))).toEqual(['ping', null, null]);
    expect(JSON.parse(serializeWireFrame('ping', null))).toEqual(['ping', null, null]);
    expect(v.safeParse(UserEventFrameSchema, ['ping', null, null]).success).toBe(true);
    expect(v.safeParse(UserEventFrameSchema, ['ping', null, null, 'extra']).success).toBe(false);
  });

  it('serializes nested metadata groups', () => {
    expect(
      JSON.parse(
        serializeWireFrame(
          'chunk',
          { n: 1 },
          {
            correlationId: 'exchange-1',
            source: 'client',
            channel: 'room-1',
            channelFamily: 'rooms',
            messageId: 'message-1',
            deliverySeq: 7,
            streamId: 'stream-1',
            eventName: 'chunk',
            streamDurability: 'persistent',
            streamSeq: 7,
            streamNudgeId: 'nudge-1',
            streamTerminated: false,
          },
        ),
      ),
    ).toEqual([
      'chunk',
      { n: 1 },
      {
        exchange: { id: 'exchange-1', source: 'client' },
        channel: { name: 'room-1', family: 'rooms' },
        delivery: { id: 'message-1', seq: 7 },
        stream: {
          id: 'stream-1',
          event: 'chunk',
          durability: 'persistent',
          seq: 7,
          nudgeId: 'nudge-1',
          terminated: false,
        },
      },
    ]);
  });

  it('omits channel.family when no family is set', () => {
    expect(metadataFromLiveThing({ channel: 'room' })).toEqual({ channel: { name: 'room' } });
    expect(JSON.parse(serializeWireFrame('event', {}, { channel: 'room' }))[2]).toEqual({
      channel: { name: 'room' },
    });
  });

  it('maps delivery.id and stream.durability when reading', () => {
    expect(
      parseUserEventFrame(['event', {}, { delivery: { id: 'message-1', seq: 3 } }]).__livething,
    ).toMatchObject({ messageId: 'message-1', deliverySeq: 3 });
    expect(
      parseUserEventFrame([
        'event',
        {},
        { stream: { id: 'stream-1', durability: 'persistent', seq: 4 } },
      ]).__livething,
    ).toMatchObject({ streamId: 'stream-1', streamDurability: 'persistent', streamSeq: 4 });
  });

  it('keeps a stream sequence separate from delivery sequence', () => {
    expect(
      metadataFromLiveThing({ streamId: 'stream-1', streamSeq: 4, messageId: 'message-1' }),
    ).toEqual({
      delivery: { id: 'message-1' },
      stream: { id: 'stream-1', seq: 4 },
    });
  });

  it('uses null for no metadata and rejects empty metadata', () => {
    expect(v.safeParse(UserEventFrameSchema, ['event', {}, null]).success).toBe(true);
    expect(v.safeParse(UserEventFrameSchema, ['event', {}, {}]).success).toBe(false);
    expect(v.safeParse(UserEventFrameSchema, ['event', {}, { exchange: {} }]).success).toBe(false);
    expect(v.safeParse(UserEventFrameSchema, ['event', {}, { delivery: {} }]).success).toBe(false);
    expect(
      v.safeParse(UserEventFrameSchema, ['event', {}, { channel: { name: 'room', family: null } }])
        .success,
    ).toBe(false);

    expect(v.safeParse(MetadataSchema, {}).success).toBe(false);
  });

  it('rejects object frames and tuples without metadata', () => {
    const objectFrame = { event: 'event', payload: {}, metadata: null };
    expect(v.safeParse(UserEventFrameSchema, objectFrame).success).toBe(false);
    expect(() => parseUserEventFrame(objectFrame)).toThrow();
    expect(v.safeParse(UserEventFrameSchema, ['event', {}]).success).toBe(false);
    expect(() => parseUserEventFrame(['event', {}])).toThrow();
  });
});

describe('__replay__ resume tokens', () => {
  function tokens(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `token-${i}`);
  }

  it('accepts up to MAX_RESUME_TOKENS tokens', () => {
    expect(
      v.safeParse(ReplayFrame, [
        '__replay__',
        { lastKnownSeq: 3, resume: tokens(MAX_RESUME_TOKENS) },
        null,
      ]).success,
    ).toBe(true);
  });

  it('rejects more tokens than the cap, an empty token and a token that is not a string', () => {
    for (const resume of [tokens(MAX_RESUME_TOKENS + 1), [''], [42]]) {
      expect(
        v.safeParse(ReplayFrame, ['__replay__', { lastKnownSeq: 3, resume }, null]).success,
      ).toBe(false);
    }
  });
});

describe('nested protocol frame schemas', () => {
  it('validates tuple frames with the required metadata group', () => {
    expect(
      v.safeParse(SubscribeOkFrame, ['__subscribeOk__', null, { channel: { name: 'room' } }])
        .success,
    ).toBe(true);
    expect(
      v.safeParse(SubscribeOkFrame, ['__subscribeOk__', { seq: 2 }, { channel: { name: 'room' } }])
        .success,
    ).toBe(true);
    expect(
      v.safeParse(SubscribeOkFrame, ['__subscribeOk__', {}, { channel: { name: 'room' } }]).success,
    ).toBe(false);
    expect(
      v.safeParse(ReadFrame, ['__read__', { readThrough: 1 }, { channel: { name: 'room' } }])
        .success,
    ).toBe(true);
  });

  it.each([
    ['__subscribeOk__', { channel: 'room' }],
    ['__unsubscribeOk__', { channel: 'room' }],
    ['__streamOk__', { streamId: 'stream-1' }],
    ['__nudgeOk__', { streamId: 'stream-1' }],
    ['__streamEnd__', { streamId: 'stream-1' }],
  ])('accepts the %s frame the serializer writes', (event, livething) => {
    const wire = JSON.parse(serializeWireFrame(event, {}, livething)) as unknown[];

    expect(wire[1]).toBeNull();
    expect(v.safeParse(OutgoingProtocolFrame, wire).success).toBe(true);
  });

  it('accepts the __subscribeOk__ frame the serializer writes when replay gives a seq', () => {
    const wire = JSON.parse(
      serializeWireFrame(
        '__subscribeOk__',
        { seq: 2 },
        { channel: 'room:general', channelFamily: 'rooms', channelMembership: 'ephemeral' },
      ),
    ) as unknown[];

    expect(wire[1]).toEqual({ seq: 2 });
    expect(v.safeParse(OutgoingProtocolFrame, wire).success).toBe(true);
  });
});
