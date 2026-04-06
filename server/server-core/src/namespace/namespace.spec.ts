import { incoming } from '~/incoming/incoming.ts';
import { namespace } from '~/namespace/namespace.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { request } from '~/request/request.ts';
import { chunks, generate, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

describe('namespace', () => {
  it('produces correct tag and kind', () => {
    const p = namespace(
      'notifications',
      outgoing('alert', t<{ id: string }>()),
      incoming('dismiss', async () => {}),
    );
    expect(p.__wskit).toBe('namespace');
    expect(p.__kind).toBe('scope');
  });

  it('produces compound identity keyed by pattern', () => {
    const p = namespace(
      'notifications',
      outgoing('alert', t<{ id: string }>()),
      incoming('dismiss', async () => {}),
    );
    expect(p.__identity[1]).toBe('notifications');
  });

  it('stores string pattern and nested primitives in order', () => {
    const p = namespace(
      'notifications',
      outgoing('alert', t<{ id: string }>()),
      incoming('dismiss', async () => {}),
    );
    expect(p.pattern).toBe('notifications');
    expect(p.primitives).toHaveLength(2);
    expect(p.primitives[0]!.__wskit).toBe('outgoing');
    expect(p.primitives[1]!.__wskit).toBe('incoming');
    expect(Object.isFrozen(p.primitives)).toBe(true);
  });

  it('stores generate() children alongside other namespace primitives', () => {
    const aiStream = stream(start('ask-ai'), chunks(t<{ text: string }>()));
    const p = namespace(
      'reports',
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
    const p = namespace(
      'notifications',
      outgoing('alert', t<{ id: string }>()),
      incoming('dismiss', async () => {}),
    );
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
