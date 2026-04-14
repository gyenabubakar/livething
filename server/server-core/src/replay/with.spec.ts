import { server } from '~/_builder/server-builder.ts';
import { withDedup } from '~/dedup/with.ts';
import { event } from '~/event.ts';
import { withReplayCustom } from '~/replay/custom/with.ts';
import { withReplay } from '~/replay/with.ts';
import { withSequence } from '~/sequence/with.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

function replayReady(name: string) {
  return withReplay(withDedup(withSequence(server(name))));
}

function replayCustomReady(name: string) {
  return withReplayCustom(withDedup(withSequence(server(name))));
}

describe('.replay() side-effect', () => {
  it('adds replay primitive via callback', () => {
    const def = replayReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r)
      .outgoing(message)
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'replay')).toBe(true);
  });

  it('accepts exclude', () => {
    const def = replayReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r.exclude('typing', 'cursor'))
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: { exclude?: string[] };
    };
    expect(replayPrim.options.exclude).toEqual(['typing', 'cursor']);
  });

  it('accepts retention', () => {
    const def = replayReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r.retention({ maxAgeMs: 3_600_000, maxMessages: 1000 }))
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: { retention?: object };
    };
    expect(replayPrim.options.retention).toEqual({ maxAgeMs: 3_600_000, maxMessages: 1000 });
  });

  it('accepts durability', () => {
    const def = replayReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r.durability('best-effort'))
      .build();

    const replayPrim = def.primitives.find((p) => p.__wskit === 'replay') as unknown as {
      options: { durability?: string };
    };
    expect(replayPrim.options.durability).toBe('best-effort');
  });

  it('accepts snapshot mode with snapshotKey and reduce', () => {
    const def = replayReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replay('snapshot', (r) =>
        r
          .snapshotKey((event, payload) => `${event}:${(payload as { id: string }).id}`)
          .reduce((_prev, next) => next),
      )
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

  it('callback form returns to parent for continued chaining', () => {
    const def = replayReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r.exclude('typing').durability('strict'))
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .build();

    expect(def.primitives).toHaveLength(5);
  });
});

describe('.replayCustom() side-effect', () => {
  it('adds customReplay primitive via callback', () => {
    const def = replayCustomReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom((r) => r.onReplay(async (_ctx, _since) => {}))
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'customReplay')).toBe(true);
  });

  it('accepts onBeforeSend and onAfterSend hooks', () => {
    const def = replayCustomReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom((r) =>
        r
          .onBeforeSend((_message) => {})
          .onAfterSend((_message) => {})
          .onReplay(async (_ctx, _since) => {}),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'customReplay')).toBe(true);
  });

  it('callback form returns to parent for continued chaining', () => {
    const def = replayCustomReady('chat')
      .sequence({ persist: true })
      .dedup()
      .replayCustom((r) => r.onReplay(async () => {}))
      .outgoing(message)
      .build();

    expect(def.primitives).toHaveLength(4);
  });
});
