import type { WriteGate } from '@livething/server/adapters';

const onFailure = new Set<(gate: NodeWriteGate) => void>();

/**
 * The engine keeps the replay rows of a turn in memory and stores them in one transaction (see
 * `EngineRuntimeOptions.writeGate`). Every path that writes a frame to a client calls
 * `commitBeforeWrite()` first, so no client gets a message whose row is not stored. The sockets
 * and event streams hold a turn's frames until it ends, so in most turns the first call is the
 * end-of-turn flush, and the turn's rows go in one commit.
 *
 * Each endpoint has its own gate: a row that fails to store drops only that endpoint's frames.
 */
export class NodeWriteGate implements WriteGate {
  #commits: (() => boolean)[] = [];
  #failed = false;

  beforeNextWrite(commit: () => boolean): void {
    // A turn that writes nothing still stores its rows when it ends.
    if (this.#commits.length === 0) setImmediate(this.commitNow);

    this.#commits.push(commit);
  }

  readonly commitNow = (): boolean => this.commitBeforeWrite();

  /**
   * Run the waiting commits. Returns `false` when some row could not be stored. Then every frame
   * this endpoint holds for the end of the turn is dropped and its connection closed, since it
   * can carry a message no client may get, and the caller must not write the frame it was about to.
   *
   * A broadcast sends to its members one after another in the same task, and only the first write
   * runs the commit. So after a failure, every write and hold of this task is refused too, until
   * the task ends.
   */
  commitBeforeWrite(): boolean {
    if (this.#failed) return false;

    if (this.#commits.length === 0) return true;

    let stored = true;
    for (const commit of this.#commits.splice(0)) {
      try {
        if (!commit()) stored = false;
      } catch {
        stored = false;
      }
    }

    if (stored) return true;

    this.#failed = true;
    queueMicrotask(() => {
      this.#failed = false;
    });
    for (const drop of onFailure) drop(this);

    return false;
  }

  /** Whether a commit failed in this task: a frame held now must be dropped, not held. */
  get failed(): boolean {
    return this.#failed;
  }
}

/**
 * Run `drop` when a commit fails: it drops the frames its module holds for that gate and closes
 * their connections.
 */
export function onWriteGateFailure(drop: (gate: NodeWriteGate) => void): void {
  onFailure.add(drop);
}

const gatedTransports = new WeakMap<object, (gate: NodeWriteGate) => void>();

/**
 * Mark a transport whose `send` holds frames until the end of the turn and runs the gate itself,
 * when it writes them: the built-in WebSocket and event streams. `useGate` gets the gate of the
 * endpoint that accepts it. `createConnectionBridge` runs the gate before any other transport's
 * `send`, which costs one commit for each broadcast.
 */
export function gatesItsOwnWrites<T extends object>(
  transport: T,
  useGate: (gate: NodeWriteGate) => void,
): T {
  gatedTransports.set(transport, useGate);
  return transport;
}

/** Give `gate` to a transport that gates its own writes. Returns `false` for any other transport. */
export function giveOwnGate(transport: object, gate: NodeWriteGate): boolean {
  const useGate = gatedTransports.get(transport);
  if (!useGate) return false;

  useGate(gate);
  return true;
}

/** The close of a connection whose held frames were dropped because a commit failed. */
export const LOST_WRITE_CLOSE = { code: 1011, reason: 'The server could not store a message' };
