import { beginCatchUpHold, endCatchUpHold } from '~/_engine/runtime/catch-up-hold.ts';
import { DRAIN_BUFFER_LIMIT_BYTES } from '~/_engine/stream-common/active-stream.ts';
import type { RuntimeConnection } from './types.ts';

/*
 * What replay's catch-up and the inbox drain share: they send stored rows a page at a time,
 * wait while the socket's buffer is high, and hold the live frames of the stores they catch
 * up until their last row is sent.
 */

/** The most rows, and about the most bytes, one catch-up reads from storage at a time. */
export const CATCH_UP_PAGE = { maxRows: 256, maxBytes: 4 * 1024 * 1024 } as const;

/** How long all the waits of one catch-up may take together, as `ctx.stream.drain()` waits. */
const CATCH_UP_WAIT_MS = 50_000;
const CATCH_UP_POLL_MS = 25;

/** When the waits of a catch-up that starts now must end. */
export function catchUpDeadline(): number {
  return performance.now() + CATCH_UP_WAIT_MS;
}

/** Whether the socket reports a buffer over the `drain()` mark. Cloudflare reports none. */
export function catchUpBufferIsHigh(connection: RuntimeConnection): boolean {
  const { descriptor } = connection;
  return (
    descriptor.backpressureSupported === true &&
    descriptor.bufferedAmount() >= DRAIN_BUFFER_LIMIT_BYTES
  );
}

/** Wait for the buffer to go below the mark. `false` when the deadline came first. */
export async function waitForCatchUpBuffer(
  connection: RuntimeConnection,
  until: number,
): Promise<boolean> {
  while (catchUpBufferIsHigh(connection)) {
    if (connection.closing) return true;

    if (performance.now() >= until) return false;

    await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS));
  }

  return true;
}

/**
 * Run one catch-up of the stores named by `storeKeys` (see `seqScopeKey`). From now on, live
 * frames of those stores wait until it ends, even while it waits for the catch-up before it.
 * Catch-ups of one connection run one after another, since a catch-up that waits for the
 * buffer lets other work run. Until its first wait, it runs at once.
 */
export async function runCatchUp(
  connection: RuntimeConnection,
  storeKeys: readonly string[],
  catchUp: () => Promise<void>,
): Promise<void> {
  for (const key of storeKeys) beginCatchUpHold(connection, key);
  const before = connection.catchUp;
  let finish!: () => void;
  const mine = new Promise<void>((resolve) => (finish = resolve));

  connection.catchUp = mine;
  try {
    if (before) await before;
    if (!connection.closing) await catchUp();
  } finally {
    finish();
    if (connection.catchUp === mine) connection.catchUp = undefined;
    for (const key of storeKeys) endCatchUpHold(connection, key);
  }
}
