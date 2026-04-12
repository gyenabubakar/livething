import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/heartbeat.ts';
import '~/_builder/side-effects/sequence.ts';
import '~/_builder/side-effects/dedup.ts';
import '~/_builder/side-effects/hibernation.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('.heartbeat() side-effect', () => {
  it('adds heartbeat primitive', () => {
    const def = server('chat').heartbeat({ timeout: 60_000 }).done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('heartbeat');
  });

  it('does not add anything to ctx', () => {
    server('chat')
      .heartbeat({ timeout: 60_000 })
      .outgoing(message)
      .incoming(sendMessage, async (ctx) => {
        ctx.send('message', { text: 'hi' });

        // @ts-expect-error — heartbeat adds nothing to ctx
        ctx.heartbeat;
      });
  });
});

describe('.sequence() side-effect', () => {
  it('adds sequence primitive', () => {
    const def = server('chat').sequence().done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('sequence');
  });

  it('accepts persist option', () => {
    const def = server('chat').sequence({ persist: true }).done();
    const prim = def.primitives[0] as unknown as { persist: boolean };

    expect(prim.persist).toBe(true);
  });

  it('defaults persist to false', () => {
    const def = server('chat').sequence().done();
    const prim = def.primitives[0] as unknown as { persist: boolean };

    expect(prim.persist).toBe(false);
  });
});

describe('.dedup() side-effect', () => {
  it('adds dedup primitive', () => {
    const def = server('chat').dedup().done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('dedup');
  });
});

describe('.hibernation() side-effect', () => {
  it('adds hibernation primitive', () => {
    const def = server('chat').hibernation().done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('hibernation');
  });

  it('defaults to enabled', () => {
    const def = server('chat').hibernation().done();
    const prim = def.primitives[0] as unknown as { enabled: boolean };

    expect(prim.enabled).toBe(true);
  });

  it('can be explicitly disabled', () => {
    const def = server('chat').hibernation(false).done();
    const prim = def.primitives[0] as unknown as { enabled: boolean };

    expect(prim.enabled).toBe(false);
  });
});

describe('infrastructure primitives combined', () => {
  it('all chain together preserving order', () => {
    const def = server('chat')
      .heartbeat({ timeout: 60_000 })
      .sequence({ persist: true })
      .dedup()
      .hibernation()
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .done();

    expect(def.primitives).toHaveLength(6);
    expect(def.primitives[0]!.__wskit).toBe('heartbeat');
    expect(def.primitives[1]!.__wskit).toBe('sequence');
    expect(def.primitives[2]!.__wskit).toBe('dedup');
    expect(def.primitives[3]!.__wskit).toBe('hibernation');
    expect(def.primitives[4]!.__wskit).toBe('outgoing');
    expect(def.primitives[5]!.__wskit).toBe('incoming');
  });

  it('rejects duplicate infrastructure registrations', () => {
    expect(() => server('chat').sequence().sequence().done()).toThrow(/Duplicate registration/);
  });
});
