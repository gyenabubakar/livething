import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';

// Building a frame reads the bytes' length once, so counting the reads counts the frames built.
let lengthReads = 0;
const picture = new Uint8Array([137, 80, 78, 71]);
Object.defineProperty(picture, 'byteLength', {
  get() {
    lengthReads += 1;
    return 4;
  },
});
const general = { channel: { name: 'room:general', family: 'rooms' } };

function start(logged: unknown[][]) {
  const base = server({ capabilities: [binary(), channels()] });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
  });
  const handleStartScreenShare = base.on('start-screen-share', {
    run(ctx, input) {
      const from = (input as { from: string }).from;
      ctx.channels
        .get(rooms.at({ roomId: 'general' }))
        .binary.broadcast('screen-frame', { from }, picture);
    },
  });
  let engine!: Engine;
  adapter({
    id: 'binary-broadcast-encode-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: (...args: unknown[]) => logged.push(args) },
      });
      return {};
    },
  })(base.assemble({ handlers: [handleStartScreenShare, rooms] }), undefined as never);

  return engine;
}

async function connect(engine: Engine, userId: string) {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => sent.push(data),
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  return { handle, sent };
}

describe('a binary broadcast', () => {
  it('builds no frame when nobody receives it, and one frame for many members', async () => {
    const engine = start([]);
    const amara = await connect(engine, 'u_amara');
    lengthReads = 0;

    await amara.handle.handleMessage(JSON.stringify(['start-screen-share', { from: 'x' }, null]));
    expect(lengthReads).toBe(0);

    const kofi = await connect(engine, 'u_kofi');
    const ama = await connect(engine, 'u_ama');
    await kofi.handle.handleMessage(JSON.stringify(['__subscribe__', {}, general]));
    await ama.handle.handleMessage(JSON.stringify(['__subscribe__', {}, general]));
    await amara.handle.handleMessage(JSON.stringify(['start-screen-share', { from: 'x' }, null]));

    expect(lengthReads).toBe(1);
    expect(kofi.sent.filter((data) => data.kind === 'bytes')).toHaveLength(1);
    expect(ama.sent.filter((data) => data.kind === 'bytes')).toHaveLength(1);
  });

  it('still refuses an envelope over 64 KiB once, when nobody receives it', async () => {
    const logged: unknown[][] = [];
    const engine = start(logged);
    const amara = await connect(engine, 'u_amara');

    await amara.handle.handleMessage(
      JSON.stringify(['start-screen-share', { from: 'x'.repeat(70_000) }, null]),
    );

    expect(logged.map((entry) => entry[0])).toEqual([
      '[livething] channel broadcast preparation failed; no members received',
    ]);
  });
});
