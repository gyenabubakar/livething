import { ack as _ack } from '~/ack/index.ts';
import { dedup as _dedup, dedup } from '~/dedup/index.ts';
import { heartbeat as _heartbeat } from '~/heartbeat/index.ts';
import { incoming as _incoming } from '~/incoming/index.ts';
import { received, server, t } from '~/index.ts';
import { outgoing as _outgoing } from '~/outgoing/index.ts';
import { replay as _replay } from '~/replay/index.ts';
import { sequence as _sequence, sequence } from '~/sequence/index.ts';
import { describe, expect, it } from 'vitest';
import type { heartbeat } from '~/heartbeat/index.ts';
import type { replay } from '~/replay/index.ts';

describe('server()', () => {
  it('injects enabled default infrastructure into define()', () => {
    const {
      define,
      incoming: boundIncoming,
      outgoing: boundOutgoing,
    } = server('chat', {
      _ack,
      _heartbeat,
      _incoming,
      _outgoing,
    });

    const chat = define(
      boundOutgoing('message', t<{ text: string }>()),
      boundIncoming(received('ping'), async () => {}),
    );

    expect(chat.primitives.map((primitive) => primitive.__wskit)).toEqual([
      'ack',
      'heartbeat',
      'outgoing',
      'incoming',
    ]);
    const injectedHeartbeat = (
      chat.primitives as readonly { __wskit: string; timeout?: number }[]
    ).find((primitive) => primitive.__wskit === 'heartbeat');
    expect(injectedHeartbeat?.timeout).toBe(30_000);
  });

  it('does not duplicate explicit infrastructure overrides', () => {
    const {
      define,
      heartbeat: boundHeartbeat,
      incoming: boundIncoming,
      outgoing: boundOutgoing,
    } = server('chat', {
      _ack,
      _heartbeat,
      _incoming,
      _outgoing,
    });

    const chat = define(
      boundHeartbeat({ timeout: 45_000 }),
      boundOutgoing('message', t<{ text: string }>()),
      boundIncoming(received('ping'), async () => {}),
    );

    const explicitHeartbeat = chat.primitives.find(
      (primitive) => primitive.__wskit === 'heartbeat',
    ) as ReturnType<typeof heartbeat> | undefined;
    expect(explicitHeartbeat).toBeDefined();
    if (!explicitHeartbeat) throw new Error('expected explicit heartbeat');
    expect(explicitHeartbeat.timeout).toBe(45_000);
  });

  it('injects replay defaults after infrastructure dependencies when enabled', () => {
    const {
      define,
      incoming: boundIncoming,
      outgoing: boundOutgoing,
    } = server('chat', {
      _incoming,
      _outgoing,
      _heartbeat,
      _sequence,
      _dedup,
      _replay,
    });

    const chat = define(
      boundOutgoing('message', t<{ text: string }>()),
      boundIncoming(received('ping'), async () => {}),
    );

    expect(chat.primitives.map((primitive) => primitive.__wskit)).toEqual([
      'heartbeat',
      'sequence',
      'dedup',
      'replay',
      'outgoing',
      'incoming',
    ]);
  });

  it('injects enabled defaults individually when passive support is not enabled', () => {
    const {
      define,
      incoming: boundIncoming,
      outgoing: boundOutgoing,
    } = server('chat', {
      _ack,
      _heartbeat,
      _incoming,
      _outgoing,
      _sequence,
      _dedup,
      _replay,
    });

    const chat = define(
      boundOutgoing('message', t<{ text: string }>()),
      boundIncoming(received('ping'), async () => {}),
    );

    expect(chat.primitives.map((primitive) => primitive.__wskit)).toEqual([
      'ack',
      'heartbeat',
      'sequence',
      'dedup',
      'replay',
      'outgoing',
      'incoming',
    ]);

    const injectedHeartbeat = (chat.primitives as readonly { __wskit: string }[]).find(
      (primitive) => primitive.__wskit === 'heartbeat',
    ) as ReturnType<typeof heartbeat> | undefined;
    expect(injectedHeartbeat).toBeDefined();
    if (!injectedHeartbeat) throw new Error('expected injected heartbeat');
    expect(injectedHeartbeat.timeout).toBe(30_000);
  });

  it('throws when replay defaults are enabled without sequence and dedup support', () => {
    const {
      define,
      incoming: boundIncoming,
      outgoing: boundOutgoing,
    } = server('chat', {
      _incoming,
      _outgoing,
      _replay,
    });

    expect(() =>
      define(
        boundOutgoing('message', t<{ text: string }>()),
        boundIncoming(received('ping'), async () => {}),
      ),
    ).toThrow(/requires a missing dependency/);
  });

  it('does not duplicate explicit replay configuration', () => {
    const {
      define,
      replay: boundReplay,
      incoming: boundIncoming,
      outgoing: boundOutgoing,
    } = server('chat', {
      _incoming,
      _outgoing,
      _sequence,
      _dedup,
      _replay,
    });

    const chat = define(
      sequence(),
      dedup(),
      boundReplay({
        type: 'history',
        retention: {
          maxAgeMs: 60_000,
        },
      }),
      boundOutgoing('message', t<{ text: string }>()),
      boundIncoming(received('ping'), async () => {}),
    );

    expect(chat.primitives.filter((primitive) => primitive.__wskit === 'replay')).toHaveLength(1);
    expect((chat.primitives[2] as ReturnType<typeof replay>).options).toEqual({
      type: 'history',
      retention: {
        maxAgeMs: 60_000,
      },
    });
  });
});
