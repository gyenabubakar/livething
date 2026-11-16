import type { WriteGate } from '@livething/server/adapters';

/**
 * The engine keeps the replay rows of a turn in memory and stores them in one transaction (see
 * `EngineRuntimeOptions.writeGate`). Every path that writes a frame to a client calls
 * `commitBeforeWrite()` first, so no client gets a message whose row is not stored. The sockets
 * and event streams hold a turn's frames until it ends, so in most turns the first call is the
 * end-of-turn flush, and the turn's rows go in one commit.
 */
const commits: (() => boolean)[] = [];
const onFailure = new Set<() => void>();
let failed = false;

export const nodeWriteGate: WriteGate = {
  beforeNextWrite(commit) {
    // A turn that writes nothing still stores its rows when it ends.
    if (commits.length === 0) setImmediate(commitBeforeWrite);

    commits.push(commit);
  },
  commitNow: commitBeforeWrite,
};

/**
 * Run the waiting commits. Returns `false` when some row could not be stored. Then every frame
 * held for the end of the turn is dropped and its connection closed, since it can carry a
 * message no client may get, and the caller must not write the frame it was about to.
 *
 * A broadcast sends to its members one after another in the same task, and only the first write
 * runs the commit. So after a failure, every write and hold of this task is refused too, until
 * the task ends.
 */
export function commitBeforeWrite(): boolean {
  if (failed) return false;

  if (commits.length === 0) return true;

  let stored = true;
  for (const commit of commits.splice(0)) {
    try {
      if (!commit()) stored = false;
    } catch {
      stored = false;
    }
  }

  if (stored) return true;

  failed = true;
  queueMicrotask(() => {
    failed = false;
  });
  for (const drop of onFailure) drop();

  return false;
}

/** Whether a commit failed in this task: a frame held now must be dropped, not held. */
export function writeFailed(): boolean {
  return failed;
}

/** Run `drop` when a commit fails: it drops the frames its module holds and closes their connections. */
export function onWriteGateFailure(drop: () => void): void {
  onFailure.add(drop);
}

const gatedTransports = new WeakSet<object>();

/**
 * Mark a transport whose `send` holds frames until the end of the turn and runs the gate itself,
 * when it writes them: the built-in WebSocket and event streams. `createConnectionBridge` runs
 * the gate before any other transport's `send`, which costs one commit for each broadcast.
 */
export function gatesItsOwnWrites<T extends object>(transport: T): T {
  gatedTransports.add(transport);
  return transport;
}

export function gatesOwnWrites(transport: object): boolean {
  return gatedTransports.has(transport);
}

/** The close of a connection whose held frames were dropped because a commit failed. */
export const LOST_WRITE_CLOSE = { code: 1011, reason: 'The server could not store a message' };
