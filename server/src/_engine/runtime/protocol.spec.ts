import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  isProtocolEventName,
  OUTGOING_PROTOCOL_EVENT_NAMES,
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

describe('outgoing protocol event names', () => {
  it('pins the exact set of event names the engine emits', () => {
    // Outgoing frames are not validated, so the engine lists these names by hand
    // instead of deriving them from schemas. This guards the hardcoded list.
    expect(OUTGOING_PROTOCOL_EVENT_NAMES).toEqual(
      new Set([
        '__subscribeOk__',
        '__unsubscribeOk__',
        '__streamOk__',
        '__nudgeOk__',
        '__streamEnd__',
        '__error__',
        '__kicked__',
        '__memberJoin__',
        '__memberLeave__',
        '__memberOnline__',
        '__memberOffline__',
        '__memberSync__',
      ]),
    );
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

describe('protocol event detection', () => {
  it('detects protocol-shaped double-underscore names', () => {
    expect(isProtocolEventName('__subscribe__')).toBe(true);
    expect(isProtocolEventName('__e2e:feed::ping')).toBe(false);
    expect(isProtocolEventName('ping')).toBe(false);
  });
});
