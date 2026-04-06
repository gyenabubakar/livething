import { defineServer } from '~/define-server.ts';
import { error } from '~/errors.ts';
import { ack } from '~/primitives/ack.ts';
import { channel, scope } from '~/primitives/channel.ts';
import { errors } from '~/primitives/errors.ts';
import { incoming } from '~/primitives/incoming.ts';
import { namespace } from '~/primitives/namespace.ts';
import { outgoing } from '~/primitives/outgoing.ts';
import { request } from '~/primitives/request.ts';
import { chunks, generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

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
});
