/**
 * The client reads a binary frame's envelope with `decodeMessage` from `@livething/core`, and
 * the server reads it on its real text path: `JSON.parse`, the three-item shape check, then
 * `parseUserEventFrame` (its fast metadata check first, then the schema). Two parsers can
 * drift apart, so the same frames must get the same answer from both (binary spec 3.4, 11.4).
 */
import {
  BINARY_ENVELOPE_LIMIT,
  decodeMessage,
  encodeBinaryFrame,
  splitBinaryFrame,
} from '@livething/core';
import {
  isWireTuple,
  metadataFromLiveThing,
  parseUserEventFrame,
} from '~/_engine/runtime/protocol.ts';
import { describe, expect, it } from 'vitest';

const longName = 'a'.repeat(10_000);

const envelopes: Record<string, string> = {
  'a top-level event with no metadata': '["avatar-preview",null,null]',
  'a top-level event with info': '["avatar-cropped",{"width":64},null]',
  'a channel event with delivery': JSON.stringify([
    'screen-frame',
    { from: 'u_amara' },
    { channel: { name: 'room:general', family: 'rooms' }, delivery: { id: 'm-8', seq: 3 } },
  ]),
  'a stream chunk': JSON.stringify([
    'download-attachment',
    null,
    { stream: { id: 'download-1', durability: 'ephemeral', seq: 1 } },
  ]),
  'a request inside a channel': JSON.stringify([
    'get-thumbnail',
    { attachmentId: 'att_1' },
    { exchange: { id: 'request-1', source: 'client' }, channel: { name: 'room:general' } },
  ]),
  'every channel field': JSON.stringify([
    'screen-frame',
    null,
    {
      channel: {
        name: 'room:general',
        family: 'rooms',
        unsubscribeId: 'u-1',
        membership: 'persistent',
        inbox: true,
        readReceipts: false,
      },
    },
  ]),
  'a metadata group that is not allowed': '["screen-frame",null,{"binary":{"size":4}}]',
  'empty metadata': '["screen-frame",null,{}]',
  'an empty delivery group': '["screen-frame",null,{"delivery":{}}]',
  'an empty exchange group': '["screen-frame",null,{"exchange":{}}]',
  'an unknown channel field': '["screen-frame",null,{"channel":{"name":"room:general","x":1}}]',
  'a channel with no name': '["screen-frame",null,{"channel":{"family":"rooms"}}]',
  'a channel name that is too long': JSON.stringify([
    'screen-frame',
    null,
    { channel: { name: longName } },
  ]),
  'an empty family': '["screen-frame",null,{"channel":{"name":"room:general","family":""}}]',
  'a negative sequence': '["screen-frame",null,{"delivery":{"seq":-1}}]',
  'a sequence that is not a whole number': '["screen-frame",null,{"delivery":{"seq":1.5}}]',
  'a sequence past the safe integers':
    '["screen-frame",null,{"delivery":{"seq":9007199254740992}}]',
  'a wrong exchange source': '["get-thumbnail",null,{"exchange":{"id":"r-1","source":"admin"}}]',
  'a wrong stream durability':
    '["download-attachment",null,{"stream":{"id":"d-1","durability":"forever"}}]',
  'a stream with no id': '["download-attachment",null,{"stream":{"seq":1}}]',
  'metadata that is an array': '["screen-frame",null,[]]',
  'metadata that is a string': '["screen-frame",null,"rooms"]',
  'an empty event name': '["",null,null]',
  'an event name that is too long': JSON.stringify([longName, null, null]),
  'an event name that is not a string': '[42,null,null]',
  'two items': '["screen-frame",null]',
  'four items': '["screen-frame",null,null,null]',
  'an object, not a tuple': '{"event":"screen-frame"}',
  'text that is not JSON': 'screen-frame',
  'a byte order mark before the JSON': '﻿["avatar-preview",null,null]',
  'a lone surrogate in the event name': '["\uD800avatar",null,null]',
  'a lone surrogate in the info': '["avatar-preview","\uDC00",null]',
};

/** The server's answer: the frame, with its metadata written back the way the server sends it. */
function serverRead(envelope: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return null;
  }

  if (!isWireTuple(parsed)) return null;

  let frame: ReturnType<typeof parseUserEventFrame>;
  try {
    frame = parseUserEventFrame(parsed);
  } catch {
    return null;
  }

  return {
    event: frame.event,
    payload: frame.payload,
    metadata: metadataFromLiveThing(frame.__livething),
  };
}

/** Both answers for one frame. A frame the shared splitter refuses is refused by both sides. */
function bothRead(frame: Uint8Array): { client: unknown; server: unknown } {
  const split = splitBinaryFrame(frame);
  if (split.kind !== 'frame') return { client: null, server: null };

  const client = decodeMessage(split.envelope);
  return {
    client: client && { ...client, metadata: client.metadata ?? null },
    server: serverRead(split.envelope),
  };
}

function expectAgreement(envelope: string): void {
  const { client, server } = bothRead(encodeBinaryFrame(envelope, new Uint8Array([1, 2, 3])));
  expect(client === null, envelope.slice(0, 200)).toBe(server === null);
  if (client) expect(server).toEqual(client);
}

describe('client and server agree on binary envelopes', () => {
  it.each(Object.entries(envelopes))('%s', (_name, envelope) => {
    expectAgreement(envelope);
  });

  it('covers frames that both accept and frames that both refuse', () => {
    const accepted = Object.values(envelopes).filter((envelope) => decodeMessage(envelope));
    expect(accepted.length).toBeGreaterThan(3);
    expect(Object.keys(envelopes).length - accepted.length).toBeGreaterThan(10);
  });

  it('agrees on an envelope of exactly 64 KiB, and the splitter refuses one byte more', () => {
    const shell = '["avatar-preview","",null]';
    const exact = `["avatar-preview","${'x'.repeat(BINARY_ENVELOPE_LIMIT - shell.length)}",null]`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(BINARY_ENVELOPE_LIMIT);

    const { client, server } = bothRead(encodeBinaryFrame(exact));
    expect(client).not.toBeNull();
    expect(server).toEqual(client);

    const header = encodeBinaryFrame('["a",null,null]');
    const over = new Uint8Array(9 + BINARY_ENVELOPE_LIMIT + 1);
    over.set(header.subarray(0, 5));
    new DataView(over.buffer).setUint32(5, BINARY_ENVELOPE_LIMIT + 1);
    expect(splitBinaryFrame(over).kind).toBe('invalid');
  });

  it('refuses truncated UTF-8 in the envelope on both sides', () => {
    const text = new TextEncoder().encode('["avatar-é",null,null]');
    const cut = text.indexOf(0xc3);
    const broken = new Uint8Array([...text.subarray(0, cut + 1), ...text.subarray(cut + 2)]);
    const frame = new Uint8Array(9 + broken.byteLength);
    frame.set([0x6c, 0x74, 0x62, 0x66, 1]);

    new DataView(frame.buffer).setUint32(5, broken.byteLength);
    frame.set(broken, 9);

    expect(splitBinaryFrame(frame)).toEqual({ kind: 'invalid', reason: 'envelope is not UTF-8' });
    expect(bothRead(frame)).toEqual({ client: null, server: null });
  });
});

/** A small seeded random number generator (mulberry32), so a failure can be run again. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe('client and server agree on random envelopes', () => {
  const next = random(20261105);
  function pick<T>(items: readonly T[]): T {
    return items[Math.floor(next() * items.length)]!;
  }

  const values: readonly unknown[] = [
    'room:general',
    'rooms',
    'm-8',
    '',
    'a'.repeat(128),
    'a'.repeat(129),
    'a'.repeat(257),
    'server',
    'client',
    'admin',
    'persistent',
    'ephemeral',
    0,
    3,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    true,
    false,
    null,
    [],
    {},
    { name: 'room:general' },
  ];
  const fields: Record<string, readonly string[]> = {
    exchange: ['id', 'source', 'extra'],
    channel: ['name', 'family', 'unsubscribeId', 'membership', 'inbox', 'readReceipts', 'extra'],
    delivery: ['id', 'seq', 'extra'],
    stream: ['id', 'event', 'durability', 'seq', 'nudgeId', 'terminated', 'extra'],
    binary: ['size'],
  };

  function randomGroup(name: string): unknown {
    if (next() < 0.1) return pick(values);

    const group: Record<string, unknown> = {};
    for (const field of fields[name]!) if (next() < 0.5) group[field] = pick(values);
    return group;
  }

  function randomMetadata(): unknown {
    const roll = next();
    if (roll < 0.15) return null;

    if (roll < 0.2) return pick(values);

    const metadata: Record<string, unknown> = {};
    for (const name of Object.keys(fields)) {
      if (next() < (name === 'binary' ? 0.05 : 0.4)) metadata[name] = randomGroup(name);
    }

    return metadata;
  }

  function randomEnvelope(): string {
    const event =
      next() < 0.9 ? pick(['avatar-preview', 'screen-frame', '__error__', '']) : pick(values);
    const frame = [event, pick(values), randomMetadata()];
    if (next() < 0.05) frame.pop();
    if (next() < 0.05) frame.push(null);

    return JSON.stringify(frame);
  }

  it('gives the same answer for 3000 seeded random envelopes', () => {
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      const envelope = randomEnvelope();
      expectAgreement(envelope);
      if (decodeMessage(envelope)) accepted++;
    }

    // The generator must make both kinds, or the test proves nothing.
    expect(accepted).toBeGreaterThan(150);
    expect(accepted).toBeLessThan(2700);
  });
});
