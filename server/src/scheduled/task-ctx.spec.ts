import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { scheduled } from './capability.ts';

async function startEngine(definition: ServerDefinition): Promise<Engine> {
  let captured: Engine | undefined;
  adapter({
    id: 'scheduled-task-ctx',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition, undefined as never);
  await captured!.initialize();

  return captured!;
}

function connect(engine: Engine, userId: string) {
  const send = vi.fn();
  const handle = engine.accept(Symbol(userId), {
    send,
    close() {},
    bufferedAmount: () => 0,
    userId,
  } as never);
  return { send, handle };
}

function eventsSent(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map(([frame]) => String(frame));
}

describe('a scheduled task ctx', () => {
  it('broadcasts to the members of a channel', async () => {
    const base = server({
      capabilities: [channels(), scheduled({ closeHuddle: null })],
    });
    const general = base.channel('general', {
      capabilities: [emits({ huddleClosing: t<{ reason: string }>() })],
    });
    const closeHuddle = base.scheduled('closeHuddle', {
      run(ctx) {
        ctx.channels.get(general).broadcast('huddleClosing', { reason: 'maintenance' });
      },
    });
    const joinGeneral = base.on('joinGeneral', {
      async run(ctx) {
        await ctx.channels.get(general).subscribe(ctx.connection);
      },
    });
    const queueClose = base.on('queueClose', {
      run(ctx) {
        ctx.schedule('closeHuddle', { time: Date.now() - 1 });
      },
    });

    const engine = await startEngine(
      base.assemble({ handlers: [general, joinGeneral, queueClose, closeHuddle] }),
    );

    const alice = connect(engine, 'alice');
    const bob = connect(engine, 'bob');
    await alice.handle.handleMessage(JSON.stringify(['joinGeneral', {}, null]));
    await bob.handle.handleMessage(JSON.stringify(['queueClose', {}, null]));
    await engine.handleAlarm();

    expect(eventsSent(alice.send).some((frame) => frame.includes('huddleClosing'))).toBe(true);
    expect(eventsSent(bob.send).some((frame) => frame.includes('huddleClosing'))).toBe(false);
  });
});
