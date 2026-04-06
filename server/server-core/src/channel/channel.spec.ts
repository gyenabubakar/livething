import { channel, scope } from '~/channel/channel.ts';
import { incoming } from '~/incoming/incoming.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { request } from '~/request/request.ts';
import { chunks, generate, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

describe('scope', () => {
  it('stores a stable key and regex pattern', () => {
    const s = scope('rooms', /^room-/);
    expect(s.key).toBe('rooms');
    expect(s.pattern).toEqual(/^room-/);
  });
});

describe('channel', () => {
  it('produces correct tag and kind', () => {
    const p = channel(
      'general',
      outgoing('message', t<{ text: string }>()),
      incoming('send-message', async () => {}),
    );
    expect(p.__wskit).toBe('channel');
    expect(p.__kind).toBe('scope');
  });

  it('uses the static channel name as identity', () => {
    const p = channel(
      'general',
      outgoing('message', t<{ text: string }>()),
      incoming('send-message', async () => {}),
    );
    expect(p.__identity[1]).toBe('general');
  });

  it('uses the scope key as identity for dynamic channel families', () => {
    const p = channel(
      scope('rooms', /^room-/),
      outgoing('message', t<{ text: string }>()),
      incoming('send-message', async () => {}),
    );
    expect(p.__identity[1]).toBe('rooms');
  });

  it('stores nested primitives in order', () => {
    const p = channel(
      'general',
      outgoing('message', t<{ text: string }>()),
      incoming('send-message', async () => {}),
      request('status', async () => ({ ok: true })),
    );
    expect(p.primitives).toHaveLength(3);
    expect(p.primitives[0]!.__wskit).toBe('outgoing');
    expect(p.primitives[1]!.__wskit).toBe('incoming');
    expect(p.primitives[2]!.__wskit).toBe('request');
    expect(Object.isFrozen(p.primitives)).toBe(true);
  });

  it('stores generate() children alongside other channel primitives', () => {
    const aiStream = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    const p = channel(
      scope('aiRooms', /^ai-room-/),
      outgoing('chunk', t<{ text: string }>()),
      incoming('ping', async () => {}),
      request('status', async () => ({ ok: true })),
      generate(aiStream, async function* () {
        yield { text: 'hi' };
      }),
    );
    expect(p.primitives).toHaveLength(4);
    expect(p.primitives[3]!.__wskit).toBe('generate');
    expect(p.primitives[3]!.__identity[1]).toBe('ask-ai');
  });

  it('instances have empty dependencies and requires', () => {
    const p = channel(
      'general',
      outgoing('message', t<{ text: string }>()),
      incoming('send-message', async () => {}),
    );
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
