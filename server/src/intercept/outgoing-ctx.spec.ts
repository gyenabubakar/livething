import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { describe, expect, it } from 'vitest';
import type { ConnectionHandle } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

interface OpenSocket {
  handle: ConnectionHandle;
  frames: string[];
}

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'outgoing-ctx',
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
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function open(engine: Engine, userId: string, refuseFrames = false): Promise<OpenSocket> {
  const frames: string[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: ({ text: data }: { kind: 'text'; text: string }) => {
      if (refuseFrames) return false;

      frames.push(data);
    },
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  await settle();
  return { handle, frames };
}

type ClientFrame = [event: string, payload: unknown, metadata?: unknown];

async function send(socket: OpenSocket, [event, payload, metadata]: ClientFrame) {
  await socket.handle.handleMessage(JSON.stringify([event, payload, metadata ?? null]));
  await settle();
}

describe('onOutgoing ctx — which connection, if any, it belongs to', () => {
  function buildApp() {
    const seen: { event: string; userId: string | undefined }[] = [];
    const base = server({
      capabilities: [
        channels(),
        emits({ note: t<{ from: string }>(), welcome: t<{}>(), left: t<{}>() }),
      ],
      onConnect(ctx) {
        ctx.send('welcome', {});
      },
      onDisconnect(ctx) {
        ctx.broadcast('left', {});
      },
      onOutgoing(ctx, frame) {
        seen.push({ event: frame.event, userId: ctx?.connection.userId });
      },
    });
    const room = base.channel('room', {
      capabilities: [emits({ joined: t<{}>() })],
      onSubscribe(ctx) {
        ctx.channel.broadcast('joined', {}, { includeSelf: true });
      },
    });
    const direct = base.on('direct', {
      run(ctx) {
        ctx.send('note', { from: 'direct' });
      },
    });

    const shout = base.on('shout', {
      run(ctx) {
        ctx.broadcast('note', { from: 'shout' });
      },
    });

    return { engine: buildEngine(base.assemble({ handlers: [room, direct, shout] })), seen };
  }

  it('is the connection for ctx.send from a handler and from onConnect', async () => {
    const { engine, seen } = buildApp();
    await engine.initialize();
    const alice = await open(engine, 'alice');
    await send(alice, ['direct', {}]);

    expect(seen).toEqual([
      { event: 'welcome', userId: 'alice' },
      { event: 'note', userId: 'alice' },
    ]);
  });

  it('is the sender, not the receiver, for a broadcast from a handler', async () => {
    const { engine, seen } = buildApp();
    await engine.initialize();
    const alice = await open(engine, 'alice');
    await open(engine, 'bob');
    seen.length = 0;

    await send(alice, ['shout', {}]);

    expect(seen).toEqual([{ event: 'note', userId: 'alice' }]);
  });

  it('is undefined for a send from a channel onSubscribe hook and from onDisconnect', async () => {
    const { engine, seen } = buildApp();
    await engine.initialize();
    const alice = await open(engine, 'alice');
    await open(engine, 'bob');
    seen.length = 0;

    await send(alice, ['__subscribe__', null, { channel: { name: 'room' } }]);
    await alice.handle.handleClose(1000, 'bye');
    await settle();

    expect(seen.filter((entry) => !entry.event.startsWith('__'))).toEqual([
      { event: 'joined', userId: undefined },
      { event: 'left', userId: undefined },
    ]);
  });
});

describe('ctx.send return value', () => {
  function buildApp() {
    const results: boolean[] = [];
    const base = server({
      capabilities: [emits({ note: t<{}>() })],
    });
    const direct = base.on('direct', {
      run(ctx) {
        results.push(ctx.send('note', {}));
      },
    });

    return { engine: buildEngine(base.assemble({ handlers: [direct] })), results };
  }

  it('returns true when the frame is handed to the socket', async () => {
    const { engine, results } = buildApp();
    await engine.initialize();
    const alice = await open(engine, 'alice');
    await send(alice, ['direct', {}]);

    expect(results).toEqual([true]);
    expect(alice.frames.some((frame) => frame.startsWith('["note"'))).toBe(true);
  });

  it('returns false when the adapter refuses the frame', async () => {
    const { engine, results } = buildApp();
    await engine.initialize();
    const alice = await open(engine, 'alice', true);
    await send(alice, ['direct', {}]);

    expect(results).toEqual([false]);
    expect(alice.frames).toEqual([]);
  });
});
