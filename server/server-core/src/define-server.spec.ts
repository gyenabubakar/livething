import { ack } from '~/ack/ack.ts';
import { channel, scope } from '~/channel/channel.ts';
import { dedup } from '~/dedup/dedup.ts';
import { defineServer } from '~/define-server.ts';
import { error } from '~/errors.ts';
import { errors } from '~/errors/errors.ts';
import { incoming } from '~/incoming/incoming.ts';
import { intercept } from '~/intercept/intercept.ts';
import { namespace } from '~/namespace/namespace.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { replay } from '~/replay/replay.ts';
import { request } from '~/request/request.ts';
import { sequence } from '~/sequence/sequence.ts';
import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';

describe('defineServer', () => {
  const Forbidden = error('forbidden', (value: unknown) => value as { reason: string });

  it('returns a frozen server definition', () => {
    const server = defineServer(
      ack(),
      outgoing('message', t<{ text: string }>()),
      incoming('ping', async () => {}),
    );

    expect(server.__wskit).toBe('server');
    expect(Object.isFrozen(server)).toBe(true);
    expect(Object.isFrozen(server.primitives)).toBe(true);
  });

  it('stores primitives in the order they were given', () => {
    const server = defineServer(
      ack(),
      outgoing('message', t<{ text: string }>()),
      incoming('ping', async () => {}),
    );

    expect(server.primitives).toHaveLength(3);
    expect(server.primitives[0]!.__wskit).toBe('ack');
    expect(server.primitives[1]!.__wskit).toBe('outgoing');
    expect(server.primitives[2]!.__wskit).toBe('incoming');
  });

  it('stores sibling stream and generate primitives in order', () => {
    const aiStream = stream(start('ask-ai'), chunks(t<{ text: string }>()), nudge('cancel'));
    const server = defineServer(
      ack(),
      outgoing('message', t<{ text: string }>()),
      outgoing('alert', t<{ level: string }>()),
      incoming('ping', async () => {}),
      request('get-status', async () => ({ ok: true })),
      generate(aiStream, async function* () {
        yield { text: 'hi' };
      }),
    );

    expect(server.primitives).toHaveLength(6);
    expect(server.primitives[5]!.__wskit).toBe('generate');
    expect(server.primitives[5]!.__identity[1]).toBe('ask-ai');
  });

  it('stores errors() alongside other primitives in order', () => {
    const aiStream = stream(start('ask-ai'), chunks(t<{ text: string }>()), nudge('cancel'));
    const server = defineServer(
      ack(),
      errors(Forbidden),
      outgoing('message', t<{ text: string }>()),
      outgoing('alert', t<{ level: string }>()),
      incoming('ping', async () => {}),
      request('get-status', async () => ({ ok: true })),
      generate(aiStream, async function* () {
        yield { text: 'hi' };
      }),
    );

    expect(server.primitives).toHaveLength(7);
    expect(server.primitives[0]!.__wskit).toBe('ack');
    expect(server.primitives[1]!.__wskit).toBe('errors');
    expect(server.primitives[1]!.__identity[0]).toBe(errors.__key);
    expect(server.primitives[6]!.__wskit).toBe('generate');
  });

  it('stores sequence(), dedup(), and replay() in order', () => {
    const replayStream = stream(start('replay-ai'), chunks(t<{ text: string }>()), nudge('cancel'));
    const server = defineServer(
      sequence(),
      dedup(),
      replay(),
      outgoing('message', t<{ text: string }>()),
      incoming('ping', async () => {}),
      request('status', async () => ({ ok: true })),
      generate(replayStream, async function* () {
        yield { text: 'hi' };
      }),
    );

    expect(server.primitives).toHaveLength(7);
    expect(server.primitives[0]!.__wskit).toBe('sequence');
    expect(server.primitives[1]!.__wskit).toBe('dedup');
    expect(server.primitives[2]!.__wskit).toBe('replay');
  });

  it('stores namespace() alongside top-level primitives in order', () => {
    const server = defineServer(
      ack(),
      outgoing('message', t<{ text: string }>()),
      incoming('ping', async () => {}),
      namespace(
        'notifications',
        outgoing('alert', t<{ id: string }>()),
        incoming('dismiss', async () => {}),
      ),
    );

    expect(server.primitives).toHaveLength(4);
    expect(server.primitives[3]!.__wskit).toBe('namespace');
    expect(server.primitives[3]!.__identity[1]).toBe('notifications');
    expect((server.primitives[3]! as ReturnType<typeof namespace>).primitives[0]!.__wskit).toBe(
      'outgoing',
    );
  });

  it('stores intercept() primitives in order at the top level', () => {
    const server = defineServer(
      ack(),
      outgoing('message', t<{ text: string }>()),
      intercept(async () => {}),
      incoming('ping', async () => {}),
    );

    expect(server.primitives).toHaveLength(4);
    expect(server.primitives[2]!.__wskit).toBe('intercept');
    expect((server.primitives[2]! as PreInterceptPrimitive).mode).toBe('pre');
  });

  it('stores channel() alongside top-level primitives in order', () => {
    const server = defineServer(
      ack(),
      outgoing('message', t<{ text: string }>()),
      incoming('ping', async () => {}),
      channel(
        scope('rooms', /^room-/),
        outgoing('typing', t<{ userId: string }>()),
        incoming('start-typing', async () => {}),
      ),
    );

    expect(server.primitives).toHaveLength(4);
    expect(server.primitives[3]!.__wskit).toBe('channel');
    expect(server.primitives[3]!.__identity[1]).toBe('rooms');
    expect((server.primitives[3]! as ReturnType<typeof channel>).primitives[0]!.__wskit).toBe(
      'outgoing',
    );
  });

  it('stores scoped intercept() primitives inside namespace and channel blocks', () => {
    const server = defineServer(
      namespace(
        'notifications',
        outgoing('alert', t<{ id: string }>()),
        intercept(async () => {}),
        incoming('dismiss', async () => {}),
      ),
      channel(
        scope('rooms', /^room-/),
        outgoing('message', t<{ text: string }>()),
        intercept('send-message', async () => {}),
        incoming('send-message', async () => {}),
      ),
    );

    const ns = server.primitives[0]! as ReturnType<typeof namespace>;
    const ch = server.primitives[1]! as ReturnType<typeof channel>;

    expect(ns.primitives[1]!.__wskit).toBe('intercept');
    expect((ns.primitives[1]! as PreInterceptPrimitive).mode).toBe('pre');
    expect(ch.primitives[1]!.__wskit).toBe('intercept');
    expect((ch.primitives[1]! as PostInterceptPrimitive).mode).toBe('post');
  });

  it('stores channel-scoped replay alongside other channel primitives', () => {
    async function onReplay() {}

    const server = defineServer(
      sequence(),
      dedup(),
      channel(
        scope('replayRooms', /^replay-room-/),
        replay({ onReplay }),
        outgoing('message', t<{ text: string }>()),
        incoming('replay-message', async () => {}),
      ),
    );

    const replayChannel = server.primitives[2]! as ReturnType<typeof channel>;
    expect(replayChannel.__wskit).toBe('channel');
    expect(replayChannel.primitives[0]!.__wskit).toBe('replay');
    expect((replayChannel.primitives[0]! as ReturnType<typeof replay>).onReplay).toBe(onReplay);
  });

  it('throws when replay() is missing sequence()', () => {
    expect(() =>
      defineServer(
        dedup(),
        replay(),
        outgoing('message', t<{ text: string }>()),
        incoming('ping', async () => {}),
      ),
    ).toThrow(/requires a missing dependency/);
  });

  it('throws when replay() is missing dedup()', () => {
    expect(() =>
      defineServer(
        sequence(),
        replay(),
        outgoing('message', t<{ text: string }>()),
        incoming('ping', async () => {}),
      ),
    ).toThrow(/requires a missing dependency/);
  });

  it('throws when channel-scoped replay() is missing top-level dependencies', () => {
    expect(() =>
      defineServer(
        channel(
          scope('replayRooms', /^replay-room-/),
          replay(),
          outgoing('message', t<{ text: string }>()),
          incoming('replay-message', async () => {}),
        ),
      ),
    ).toThrow(/requires a missing dependency/);
  });
});
