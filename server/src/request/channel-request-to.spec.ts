import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import * as v from 'valibot';
import { expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef } from '~/context.ts';

it('ctx.channel.request with { to } checks that one member without building the roster', async () => {
  const refs = new Map<string, ConnectionRef>();
  let rosterBuilds = -1;
  const base = server({
    capabilities: [channels(), serverRequests()],
    onConnect(ctx) {
      refs.set(ctx.connection.userId, ctx.connection);
    },
  });
  const room = base.channel('room', {
    capabilities: [
      serverRequests({
        confirm: { out: t<{ text: string }>(), in: v.object({ ok: v.boolean() }) },
      }),
    ],
  });
  const definition = base.assemble({
    handlers: [
      room,
      room.on('ask-bob', {
        run(ctx) {
          const members = vi.spyOn(ctx.channel, 'members');
          void ctx.channel
            .request('confirm', { text: 'ready?' }, { to: refs.get('bob')! })
            .catch(() => {});
          rosterBuilds = members.mock.calls.length;
        },
      }),
    ],
  });

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'channel-request-to-spec',
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
  const engine = captured!;
  await engine.initialize();

  async function join(userId: string) {
    const frames: string[] = [];
    const before = new Set(engine.core.connections.keys());
    const handle = engine.accept(Symbol(userId), {
      send: ({ text: data }: { kind: 'text'; text: string }) => {
        frames.push(data);
      },
      close() {},
      bufferedAmount: () => 0,
      userId,
    });
    await [...engine.core.connections.values()].find((c) => !before.has(c.id))!.lifecycleReady;
    await handle.handleMessage(
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'room' } }]),
    );

    return { handle, frames };
  }

  const alice = await join('alice');
  const bob = await join('bob');

  await alice.handle.handleMessage(JSON.stringify(['ask-bob', {}, { channel: { name: 'room' } }]));

  expect(bob.frames.some((frame) => frame.startsWith('["confirm"'))).toBe(true);
  expect(rosterBuilds).toBe(0);
});
