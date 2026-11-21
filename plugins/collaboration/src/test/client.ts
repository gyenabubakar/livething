import {
  awareness,
  binary,
  channels,
  client,
  clientRequests,
  connect,
  reconnection,
} from '@livething/client';
import { collaboration } from '~/client/plugin.ts';
import { taskBoard } from '~/test/task-board.ts';
import type { CollaborationClient, CollaborationClientOptions } from '~/client/plugin.ts';
import type { memoryNetwork } from '~/test/network.ts';
import type { HuddleClient } from '~/test/server.ts';

type Network = ReturnType<typeof memoryNetwork>;
type ClientOptions = Partial<CollaborationClientOptions<readonly [typeof taskBoard]>> & {
  /** Options for the socket's `binary()`. */
  readonly binary?: NonNullable<Parameters<typeof binary>[0]>;
};

/** A Huddle client with the Collaboration plugin, on the in-memory network. */
export function huddleClient(
  network: Network,
  userId: string,
  options: ClientOptions = {},
): {
  readonly socket: { connect(): void; disconnect(): void };
  readonly collab: CollaborationClient<readonly [typeof taskBoard]>;
} {
  const { binary: binaryOptions, ...collabOptions } = options;
  const Collaboration = collaboration({ docs: [taskBoard], closeDelayMs: 0, ...collabOptions });
  const socket = client<HuddleClient>()(
    connect('memory://huddle', { transports: [network.transport(userId)] }),
    channels(),
    binary(binaryOptions),
    awareness(),
    clientRequests(),
    reconnection({ maxDelay: 20 }),
    Collaboration(),
  );
  socket.connect();

  const collab: CollaborationClient<readonly [typeof taskBoard]> = Collaboration.use(socket);

  return { socket, collab };
}

/**
 * Wait until `check` passes, or fail after `ms`. It passes when it returns anything but
 * `false` and does not throw, so it can hold `expect`s; an async `check` is awaited.
 */
export async function until(check: () => unknown, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await check()) !== false) return;
    } catch (error) {
      if (Date.now() > end) throw error;
    }

    if (Date.now() > end) throw new Error(`timed out: ${check.toString()}`);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
