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
import type { HuddleClient } from '~/test/engine.ts';
import type { memoryNetwork } from '~/test/network.ts';

type Network = ReturnType<typeof memoryNetwork>;
type ClientOptions = Partial<CollaborationClientOptions<readonly [typeof taskBoard]>>;

/** A Huddle client with the Collaboration plugin, on the in-memory network. */
export function huddleClient(
  network: Network,
  userId: string,
  options: ClientOptions = {},
): { readonly collab: CollaborationClient<readonly [typeof taskBoard]> } {
  const Collaboration = collaboration({ docs: [taskBoard], closeDelayMs: 0, ...options });
  const socket = client<HuddleClient>()(
    connect('memory://huddle', { transports: [network.transport(userId)] }),
    channels(),
    binary(),
    awareness(),
    clientRequests(),
    reconnection({ maxDelay: 20 }),
    Collaboration(),
  );
  socket.connect();

  return { collab: Collaboration.use(socket) };
}

/** Wait until `check` passes, or fail after `ms`. */
export async function until(check: () => unknown, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (check() !== false) return;
    } catch (error) {
      if (Date.now() > end) throw error;
    }

    if (Date.now() > end) throw new Error(`timed out: ${check.toString()}`);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
