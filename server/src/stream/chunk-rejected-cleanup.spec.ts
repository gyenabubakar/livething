import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

async function startStream(definition: ServerDefinition, event: string): Promise<string[]> {
  let engine: Engine | undefined;
  adapter({
    id: 'chunk-rejected-cleanup',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition, undefined as never);

  await engine!.initialize();
  const sent: string[] = [];
  const handle = engine!.accept(Symbol('alice'), {
    send: ({ text }: { kind: 'text'; text: string }) => sent.push(text),
    close() {},
    bufferedAmount: () => 0,
    userId: 'alice',
  } as never);

  await handle.handleMessage(JSON.stringify([event, {}, { stream: { id: 's1' } }]));
  await vi.waitFor(() => expect(sent.at(-1)).toMatch(/"code":"internal-error"/));

  return sent;
}

describe('a stream whose chunk LiveThing refuses to send', () => {
  it('runs the generator finally block of a plain stream', async () => {
    const base = server({ capabilities: [stream()] });
    let cleaned = false;
    const feed = base.stream('feed', {
      async *run() {
        try {
          yield 42 as never;
        } finally {
          cleaned = true;
        }
      },
    });

    await startStream(base.assemble({ handlers: [feed] }), 'feed');

    await vi.waitFor(() => expect(cleaned).toBe(true));
  });

  it('runs the generator finally block of a recorded stream', async () => {
    const base = server({ capabilities: [recordedStream()] });
    let cleaned = false;
    const progress = base.recordedStream('progress', {
      maxChunks: 10,
      async *run() {
        try {
          // A function has no JSON, so LiveThing refuses to store or send it.
          yield (() => {}) as never;
        } finally {
          cleaned = true;
        }
      },
    });

    await startStream(base.assemble({ handlers: [progress] }), 'progress');

    await vi.waitFor(() => expect(cleaned).toBe(true));
  });
});
