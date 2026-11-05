import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { serverRequests } from '~/request/server-requests.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory } from '~/context.ts';

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const previous = current;
        current = store;
        try {
          return callback();
        } finally {
          current = previous;
        }
      },
      getStore: () => current,
    };
  };
}

function buildEngine(gate: Promise<void>, said: string[]): Engine {
  const base = server({
    upgrade: () => ({ userId: 'unused' }),
    capabilities: [channels()],
  });

  const room = base.channel('room', {
    capabilities: [emits({ said: t<{ text: string }>() })],
    async check() {
      await gate;
    },
  });

  const handleSay = room.on('say', {
    run(ctx) {
      said.push(ctx.user.id);
    },
  });

  return startEngine(base.assemble({ handlers: [handleSay] }));
}

function startEngine(definition: Parameters<ReturnType<typeof adapter>>[0]): Engine {
  let engine!: Engine;
  adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, {} as never);

  return engine;
}

describe('a channel frame sent right after its subscribe', () => {
  it('waits for the subscribe to finish instead of failing the membership check', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const said: string[] = [];
    const engine = buildEngine(gate, said);
    await engine.initialize();

    const handle = engine.accept(Symbol('ada'), {
      send: () => {},
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ada',
    });
    await Promise.resolve();

    const subscribing = handle.handleMessage(
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'room' } }]),
    );
    const saying = handle.handleMessage(JSON.stringify(['say', {}, { channel: { name: 'room' } }]));

    openGate();
    await Promise.all([subscribing, saying]);

    expect(said).toEqual(['ada']);
  });

  it('holds a frame that only claims to answer a server request', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const said: string[] = [];
    const engine = buildEngine(gate, said);
    await engine.initialize();

    const handle = engine.accept(Symbol('ada'), {
      send: () => {},
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ada',
    });
    await Promise.resolve();

    const subscribing = handle.handleMessage(
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'room' } }]),
    );
    const saying = handle.handleMessage(
      JSON.stringify([
        'say',
        {},
        { exchange: { id: 'no-such-request', source: 'server' }, channel: { name: 'room' } },
      ]),
    );

    openGate();
    await Promise.all([subscribing, saying]);

    expect(said).toEqual(['ada']);
  });

  it('does not hold the answer to a request the onSubscribe hook is waiting for', async () => {
    const base = server({
      upgrade: () => ({ userId: 'unused' }),
      capabilities: [channels(), serverRequests({})],
    });
    const outcomes: string[] = [];
    const room = base.channel('room', {
      capabilities: [
        serverRequests({
          'confirm-join': { out: t<{ room: string }>(), in: v.object({ ok: v.boolean() }) },
        }),
      ],
      async onSubscribe(ctx) {
        try {
          const answer = await ctx.channel.request(
            'confirm-join',
            { room: 'room' },
            { timeout: 500 },
          );
          outcomes.push(answer.ok ? 'confirmed' : 'refused');
        } catch (error) {
          outcomes.push(`failed:${(error as { code?: string }).code}`);
        }
      },
    });

    const engine = startEngine(base.assemble({ handlers: [room] }));
    await engine.initialize();

    const sent: unknown[][] = [];
    const handle = engine.accept(Symbol('ada'), {
      send: ({ text }: { kind: 'text'; text: string }) => sent.push(JSON.parse(text) as unknown[]),
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ada',
    });
    await Promise.resolve();

    const subscribing = handle.handleMessage(
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'room' } }]),
    );
    await vi.waitFor(() => expect(sent.some((frame) => frame[0] === 'confirm-join')).toBe(true));
    const request = sent.find((frame) => frame[0] === 'confirm-join')!;
    const { exchange } = request[2] as { exchange: { id: string } };

    await handle.handleMessage(
      JSON.stringify([
        'confirm-join',
        { ok: true },
        { exchange: { id: exchange.id, source: 'server' }, channel: { name: 'room' } },
      ]),
    );
    await subscribing;

    expect(outcomes).toEqual(['confirmed']);
  });
});
