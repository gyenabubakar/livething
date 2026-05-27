/* oxlint-disable @typescript-eslint/no-explicit-any */
import { scope } from '~/channel/channel.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import { request } from '~/request/definition.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { stream } from '~/stream/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import { contract } from './contract.ts';
import { matches, parseKey, unsafeCast } from './matches.ts';

interface MakeFrameOptions {
  routing?: InterceptFrame['routing'];
  kind?: InterceptFrame['kind'];
}

function makeFrame(event: string, payload: unknown, opts: MakeFrameOptions = {}): InterceptFrame {
  const { routing = {}, kind = 'unknown' } = opts;
  return { event, payload, routing, kind };
}

const testContract = contract<Record<string, unknown>>('app')({
  definitions: [
    incoming('send-msg', v.object({ text: v.string() })),
    request('lookup', { payload: v.object({ id: v.string() }), response: v.object({}) }),
    stream('count', { payload: v.object({ n: v.number() }), chunk: v.object({}) }),
    resumableStream('paginate', { payload: v.object({}), chunk: v.object({ row: v.number() }) }),
    recordedStream('record', { payload: v.object({}), chunk: v.object({}) }),
    channel('chat', {
      definitions: [
        incoming('send', v.object({ text: v.string() })),
        request('history', { payload: v.object({ before: v.string() }), response: v.object({}) }),
      ],
    }),
    channel(scope('rooms', /^room:.+$/), {
      definitions: [incoming('join', v.object({ user: v.string() }))],
    }),
    namespace('admin', {
      definitions: [incoming('kick-user', v.object({ userId: v.string() }))],
    }),
  ],
});

describe('parseKey', () => {
  it('parses a plain top-level key', () => {
    expect(parseKey('send-msg')).toEqual({ scope: 'top', event: 'send-msg' });
  });

  it('parses a channel-scoped key', () => {
    expect(parseKey('@chat::send')).toEqual({ scope: 'channel', name: 'chat', event: 'send' });
  });

  it('parses a namespace-scoped key', () => {
    expect(parseKey('#admin::kick-user')).toEqual({
      scope: 'namespace',
      name: 'admin',
      event: 'kick-user',
    });
  });

  it('rejects a key starting with @ but missing the separator', () => {
    expect(() => parseKey('@chat-send')).toThrow(/missing the '::' separator/);
  });

  it('rejects a key starting with # but missing the separator', () => {
    expect(() => parseKey('#admin-kick')).toThrow(/missing the '::' separator/);
  });

  it('rejects a key containing :: without a scope prefix', () => {
    expect(() => parseKey('send::message')).toThrow(/no scope prefix/);
  });

  it('rejects an empty scope name', () => {
    expect(() => parseKey('@::event')).toThrow(/empty name or event/);
  });

  it('rejects an empty event after the separator', () => {
    expect(() => parseKey('@chat::')).toThrow(/empty name or event/);
  });

  it('rejects an empty string', () => {
    expect(() => parseKey('')).toThrow(/non-empty string/);
  });
});

describe('matches — happy path', () => {
  it('matches a top-level incoming event with valid payload', () => {
    const frame = makeFrame('send-msg', { text: 'hi' });
    expect(matches(testContract, 'send-msg', frame)).toBe(true);
  });

  it('matches a top-level request event with valid payload', () => {
    const frame = makeFrame('lookup', { id: 'x' });
    expect(matches(testContract, 'lookup', frame)).toBe(true);
  });

  it('matches a top-level stream open with valid payload', () => {
    const frame = makeFrame('count', { n: 5 });
    expect(matches(testContract, 'count', frame)).toBe(true);
  });

  it('matches a resumableStream open', () => {
    const frame = makeFrame('paginate', {});
    expect(matches(testContract, 'paginate', frame)).toBe(true);
  });

  it('matches a recordedStream open', () => {
    const frame = makeFrame('record', {});
    expect(matches(testContract, 'record', frame)).toBe(true);
  });

  it('matches a channel-scoped event with the routing set', () => {
    const frame = makeFrame(
      'send',
      { text: 'hi' },
      { routing: { channel: 'chat', channelScope: null } },
    );
    expect(matches(testContract, '@chat::send', frame)).toBe(true);
  });

  it('matches a channel-family event with concrete channel name + family scope', () => {
    const frame = makeFrame(
      'join',
      { user: 'alice' },
      { routing: { channel: 'room:42', channelScope: 'rooms' } },
    );
    expect(matches(testContract, '@rooms::join', frame)).toBe(true);
  });

  it('matches a namespace-scoped event', () => {
    const frame = makeFrame('kick-user', { userId: 'u1' }, { routing: { namespace: 'admin' } });
    expect(matches(testContract, '#admin::kick-user', frame)).toBe(true);
  });
});

describe('matches — sad path', () => {
  it('returns false on event-name mismatch', () => {
    const frame = makeFrame('other', { text: 'hi' });
    expect(matches(testContract, 'send-msg', frame)).toBe(false);
  });

  it('returns false when top-level key gets a channel-scoped frame', () => {
    const frame = makeFrame('send-msg', { text: 'hi' }, { routing: { channel: 'chat' } });
    expect(matches(testContract, 'send-msg', frame)).toBe(false);
  });

  it('returns false when top-level key gets a namespace-scoped frame', () => {
    const frame = makeFrame('send-msg', { text: 'hi' }, { routing: { namespace: 'admin' } });
    expect(matches(testContract, 'send-msg', frame)).toBe(false);
  });

  it('returns false when channel scope mismatches', () => {
    const frame = makeFrame('send', { text: 'hi' }, { routing: { channel: 'other' } });
    expect(matches(testContract, '@chat::send', frame)).toBe(false);
  });

  it('returns false when a channel-family frame carries the wrong family key', () => {
    const frame = makeFrame(
      'join',
      { user: 'alice' },
      { routing: { channel: 'room:42', channelScope: 'other-family' } },
    );
    expect(matches(testContract, '@rooms::join', frame)).toBe(false);
  });

  it('returns false when a channel-family frame carries a concrete name outside the regex', () => {
    const frame = makeFrame(
      'join',
      { user: 'alice' },
      { routing: { channel: 'lobby', channelScope: 'rooms' } },
    );
    expect(matches(testContract, '@rooms::join', frame)).toBe(false);
  });

  it('returns false when namespace scope mismatches', () => {
    const frame = makeFrame('kick-user', { userId: 'u1' }, { routing: { namespace: 'other' } });
    expect(matches(testContract, '#admin::kick-user', frame)).toBe(false);
  });

  it('returns false when the payload fails validation', () => {
    const frame = makeFrame('send-msg', { wrong: 'shape' });
    expect(matches(testContract, 'send-msg', frame)).toBe(false);
  });

  it('throws on an unknown top-level event key', () => {
    const frame = makeFrame('does-not-exist', {});
    expect(() => matches(testContract, 'does-not-exist', frame)).toThrow(
      /references an event the contract does not declare/,
    );
  });

  it('throws on an unknown channel key', () => {
    const frame = makeFrame('send', { text: 'hi' });
    expect(() => matches(testContract, '@nonsense::send', frame)).toThrow(
      /references an event the contract does not declare/,
    );
  });

  it('throws on an unknown namespace key', () => {
    const frame = makeFrame('kick-user', { userId: 'u1' });
    expect(() => matches(testContract, '#nonsense::kick-user', frame)).toThrow(
      /references an event the contract does not declare/,
    );
  });
});

describe('matches — narrows the frame type predicate', () => {
  it('narrows event, payload, kind, and routing on the true branch', () => {
    const frame: InterceptFrame = makeFrame('send-msg', { text: 'hi' });
    if (matches(testContract, 'send-msg', frame)) {
      // Type-level: these reads should compile without `as` casts.
      const _event: 'send-msg' = frame.event;
      const _payload: { text: string } = frame.payload;
      const _kind: 'incoming' = frame.kind;
      void [_event, _payload, _kind];
    } else {
      expect.fail('matches should have returned true');
    }
  });

  it('narrows routing.channel literal on a channel match', () => {
    const frame: InterceptFrame = makeFrame(
      'send',
      { text: 'hi' },
      { routing: { channel: 'chat', channelScope: null } },
    );
    if (matches(testContract, '@chat::send', frame)) {
      const _channel: 'chat' = frame.routing.channel;
      const _kind: 'incoming' = frame.kind;
      void [_channel, _kind];
    } else {
      expect.fail('matches should have returned true');
    }
  });
});

describe('unsafeCast', () => {
  it('returns the same frame reference unchanged at runtime', () => {
    const frame = makeFrame('send-msg', { text: 'hi' });
    const cast = unsafeCast(testContract, 'send-msg', frame);
    expect(cast).toBe(frame);
  });

  it('throws on an unknown key', () => {
    const frame = makeFrame('whatever', {});
    expect(() => unsafeCast(testContract, 'does-not-exist', frame)).toThrow(
      /references an event the contract does not declare/,
    );
  });

  it('does NOT run the validator (returns even for invalid payloads)', () => {
    // unsafeCast trusts the caller — no validation runs. This is the whole
    // point of the "unsafe" name.
    const frame = makeFrame('send-msg', { wrong: 'shape' });
    expect(() => unsafeCast(testContract, 'send-msg', frame)).not.toThrow();
  });
});
