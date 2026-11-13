import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { connectedPayload } from '~/_test/connected.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { uploads } from '~/upload/capability.ts';
import { describe, expect, it } from 'vitest';
import type { ConnectionDescriptor } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

async function start(
  definition: ServerDefinition,
  options: { hibernation?: boolean } = {},
): Promise<Engine> {
  let captured!: Engine;
  const runAdapter = adapter({
    id: 'connected-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    ...(options.hibernation
      ? { hibernation: { persist: () => {}, restore: () => undefined } }
      : {}),
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
  runAdapter(definition as never, undefined as never);
  await captured.initialize();

  return captured;
}

/** The first frame the engine sends a new connection. */
async function firstFrame(engine: Engine, extra: Partial<ConnectionDescriptor> = {}) {
  const sent: string[] = [];
  engine.accept(Symbol('amara'), {
    send: (frame) => void sent.push((frame as { text: string }).text),
    close: () => {},
    bufferedAmount: () => 0,
    userId: 'u_amara',
    ...extra,
  });
  const connection = [...engine.core.connections.values()].at(-1)!;
  await connection.lifecycleReady;

  return { frame: JSON.parse(sent[0]!) as unknown[], connectionId: connection.id };
}

describe('the __connected__ frame', () => {
  it('is the first frame, with the timings, features and resume point of the server', async () => {
    const engine = await start(
      server({
        capabilities: [
          keepalive({ pingIntervalMs: 20_000, idleTimeoutMs: 60_000 }),
          dedup(),
          sequence({ persist: true }),
          replay.history(),
          binary(),
          uploads(),
        ],
      }).assemble({ handlers: [] }),
    );

    const { frame, connectionId } = await firstFrame(engine);

    expect(frame[0]).toBe('__connected__');
    expect(frame[2]).toBeNull();
    expect(connectedPayload(JSON.stringify(frame))).toEqual({
      pingIntervalMs: 20_000,
      idleTimeoutMs: 60_000,
      maxResumeTokens: 8,
      connectionId,
      features: ['replay', 'binary', 'uploads'],
      resume: { token: expect.stringMatching(/^[0-9a-f-]{36}$/), seq: expect.any(Number) },
      secret: null,
      maxPostBytes: null,
    });
  });

  it('has null timings without keepalive, and no resume point without replay', async () => {
    const engine = await start(server({}).assemble({ handlers: [] }));

    const { frame } = await firstFrame(engine);

    expect(frame[1]).toMatchObject({
      pingIntervalMs: null,
      idleTimeoutMs: null,
      features: [],
      resume: null,
    });
  });

  it('has null timings when the server hibernates, since no ping timer runs', async () => {
    const engine = await start(
      server({
        hibernation: true,
        capabilities: [keepalive({ pingIntervalMs: 20_000, idleTimeoutMs: 60_000 })],
      }).assemble({ handlers: [] }),
      { hibernation: true },
    );

    const { frame } = await firstFrame(engine);

    expect(frame[1]).toMatchObject({ pingIntervalMs: null, idleTimeoutMs: null });
  });

  it('carries the POST secret and size limit the transport gave the connection', async () => {
    const engine = await start(server({}).assemble({ handlers: [] }));

    const { frame } = await firstFrame(engine, { secret: 's3cr3t', maxPostBytes: 65_536 });

    expect(frame[1]).toMatchObject({ secret: 's3cr3t', maxPostBytes: 65_536 });
  });
});
