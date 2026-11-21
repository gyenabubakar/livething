import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { MessageLimits } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';

const limits = { receiveBytes: 1024 * 1024, sendBytes: 512 * 1024 };

describe('ctx.messageLimits', () => {
  it("gives the adapter's message limits to onInit, to handlers and to the admin ctx", async () => {
    const seen: Record<string, MessageLimits> = {};
    const base = server({
      onInit(ctx) {
        seen.init = ctx.messageLimits;
      },
    });
    const ping = base.on('ping-room', {
      input: v.object({}),
      run(ctx) {
        seen.handler = ctx.messageLimits;
      },
    });

    let engine!: Engine;
    adapter({
      id: 'message-limits-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        engine = createEngine({
          storage: createTestStorage(),
          timers: createTestTimers(),
          platform: {},
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          messageLimits: limits,
        });
        return {};
      },
    })(base.assemble({ handlers: [ping] }), undefined as never);
    await engine.initialize();

    const sent: string[] = [];
    const handle = engine.accept(Symbol('ama'), {
      send: ({ text }: { kind: 'text'; text: string }) => sent.push(text),
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ama',
    });
    await [...engine.core.connections.values()].at(-1)!.lifecycleReady;
    await handle.handleMessage(JSON.stringify(['ping-room', {}, null]));
    seen.admin = (engine.admin() as unknown as { messageLimits: MessageLimits }).messageLimits;

    expect(sent.filter((frame) => !frame.startsWith('["__connected__"'))).toEqual([]);
    expect(seen).toEqual({ init: limits, handler: limits, admin: limits });
    expect(Object.isFrozen(seen.handler)).toBe(true);
  });
});
