import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import * as v from 'valibot';
import { bench, describe } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';

type AnyServerDefinition = ServerDefinition<readonly Primitive[], ServerContract, unknown, unknown>;

const TickInput = v.object({ n: v.number() });

/**
 * A socket stand-in for the boot restore path. The engine reads the attachment
 * to learn which persisted row belongs to this socket, exactly as the Cloudflare
 * adapter's hibernation tag does.
 */
interface FakeSocket {
  id: string;
  send(data: string): void;
  close(): void;
}

function hibernatingHandler(): AnyServerDefinition {
  const base = define({ env: t<Record<string, never>>(), hibernation: { enabled: true } });
  return base.assemble({
    handlers: [base.on('tick', { input: TickInput, run() {} })],
  }) as AnyServerDefinition;
}

async function makeEngine(): Promise<Engine> {
  let engine: Engine | undefined;
  const server = adapter({
    id: 'bench',
    hibernation: {
      persist() {},
      restore: (wsKey: unknown) => ({ id: (wsKey as FakeSocket).id }),
    },
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        env: {},
        platform: {},
        timers: createTestTimers(),
        waitUntil: () => {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(hibernatingHandler(), {} as never);
  await engine!.initialize();
  return engine!;
}

function makeSocket(index: number): FakeSocket {
  return {
    id: `s${index}`,
    send() {},
    close() {},
  };
}

/**
 * Accept `count` connections so their rows land in storage, then drop every one
 * from memory. What is left is the state a Durable Object wakes into: rows on
 * disk and sockets the platform still holds.
 */
async function seed(count: number): Promise<{ engine: Engine; sockets: FakeSocket[] }> {
  const engine = await makeEngine();
  const sockets: FakeSocket[] = [];
  for (let i = 0; i < count; i++) {
    const socket = makeSocket(i);
    sockets.push(socket);
    engine.accept(socket, {
      send: () => {},
      close: () => {},
      bufferedAmount: () => 0,
      identity: `u${i}`,
    });
  }
  // The row id the adapter's attachment reports has to match what was written.
  const ids = [...engine.core.connections.keys()];
  for (const [index, socket] of sockets.entries()) socket.id = ids[index]!;

  engine.core.connections.clear();
  engine.core.usersByKey.clear();
  engine.core.wsToConnectionId.clear();
  return { engine, sockets };
}

for (const socketCount of [200, 1000]) {
  const { engine, sockets } = await seed(socketCount);

  describe(`hibernation boot restore · ${socketCount} surviving sockets`, () => {
    bench('restoreHibernatedConnections', () => {
      // Back to the woken-but-empty state before each run; the rows stay on disk.
      engine.core.connections.clear();
      engine.core.usersByKey.clear();
      engine.core.wsToConnectionId.clear();
      engine.restoreHibernatedConnections(sockets);
    });
  });
}
