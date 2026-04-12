import { server } from '~/_builder/server-builder.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/sequence.ts';
import '~/_builder/side-effects/dedup.ts';
import '~/_builder/side-effects/replay.ts';
import '~/_builder/side-effects/replay-custom.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

describe('.replay() side-effect', () => {
  it('adds replay primitive via sub-builder', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replay()
      .done()
      .outgoing(message)
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'replay')).toBe(true);
  });

  it('accepts exclude', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replay()
      .exclude('typing', 'cursor')
      .done()
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: { exclude?: string[] };
    };
    expect(replayPrim.options.exclude).toEqual(['typing', 'cursor']);
  });

  it('accepts retention', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replay()
      .retention({ maxAgeMs: 3_600_000, maxMessages: 1000 })
      .done()
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: { retention?: object };
    };
    expect(replayPrim.options.retention).toEqual({ maxAgeMs: 3_600_000, maxMessages: 1000 });
  });

  it('accepts durability', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replay()
      .durability('best-effort')
      .done()
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: { durability?: string };
    };
    expect(replayPrim.options.durability).toBe('best-effort');
  });

  it('accepts snapshot mode with snapshotKey and reduce', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replay('snapshot')
      .snapshotKey((event, payload) => `${event}:${(payload as { id: string }).id}`)
      .reduce((_prev, next) => next)
      .done()
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: {
        type?: string;
        snapshotKey?: (...args: unknown[]) => unknown;
        reduce?: (...args: unknown[]) => unknown;
      };
    };
    expect(replayPrim.options.type).toBe('snapshot');
    expect(typeof replayPrim.options.snapshotKey).toBe('function');
    expect(typeof replayPrim.options.reduce).toBe('function');
  });

  it('chains fluently — .done() returns to parent', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replay()
      .exclude('typing')
      .durability('strict')
      .done()
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .build();

    expect(def.primitives).toHaveLength(5);
  });
});

describe('.replayCustom() side-effect', () => {
  it('adds customReplay primitive via sub-builder', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom()
      .onReplay(async (_ctx, _since) => {})
      .done()
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'customReplay')).toBe(true);
  });

  it('accepts onBeforeSend and onAfterSend hooks', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom()
      .onBeforeSend((_message) => {})
      .onAfterSend((_message) => {})
      .onReplay(async (_ctx, _since) => {})
      .done()
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'customReplay')).toBe(true);
  });

  it('chains fluently — .done() returns to parent', () => {
    const def = server('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom()
      .onReplay(async () => {})
      .done()
      .outgoing(message)
      .build();

    expect(def.primitives).toHaveLength(4);
  });
});
