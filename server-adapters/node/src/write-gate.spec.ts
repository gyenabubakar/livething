import { describe, expect, it, vi } from 'vitest';
import type { ConnectionDescriptor, TransportFrame } from '@livething/server/adapters';
import { createConnectionBridge } from './socket.ts';
import {
  commitBeforeWrite,
  gatesItsOwnWrites,
  nodeWriteGate,
  onWriteGateFailure,
} from './write-gate.ts';

const hello: TransportFrame = { kind: 'text', text: 'hello', shared: false };

describe('the Node write gate', () => {
  it('runs a waiting commit once, before the next write', () => {
    const commit = vi.fn(() => true);
    nodeWriteGate.beforeNextWrite(commit);

    expect(commitBeforeWrite()).toBe(true);
    expect(commitBeforeWrite()).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('runs a waiting commit at the end of a turn that writes nothing', async () => {
    const commit = vi.fn(() => true);
    nodeWriteGate.beforeNextWrite(commit);

    await new Promise((resolve) => setImmediate(resolve));

    expect(commit).toHaveBeenCalledOnce();
  });

  it('reports a failed commit, and a commit that throws, to the failure drops', async () => {
    const drop = vi.fn();
    onWriteGateFailure(drop);
    nodeWriteGate.beforeNextWrite(() => false);

    expect(commitBeforeWrite()).toBe(false);
    expect(drop).toHaveBeenCalledOnce();

    await Promise.resolve();
    nodeWriteGate.beforeNextWrite(() => {
      throw new Error('disk full');
    });

    expect(commitBeforeWrite()).toBe(false);
    expect(drop).toHaveBeenCalledTimes(2);
  });

  it('refuses every other write of the same broadcast after a failed commit', async () => {
    nodeWriteGate.beforeNextWrite(() => false);

    expect(commitBeforeWrite()).toBe(false);
    expect(commitBeforeWrite()).toBe(false);
    expect(nodeWriteGate.commitNow()).toBe(false);

    await Promise.resolve();
    expect(commitBeforeWrite()).toBe(true);
  });
});

describe('a connection a framework or custom transport accepts', () => {
  class CustomConnection {
    readonly sent: string[] = [];
    readonly closes: number[] = [];
    readonly backpressureSupported = true;
    #buffered = 3;

    send(frame: TransportFrame) {
      this.sent.push(frame.kind === 'text' ? frame.text : 'bytes');
    }

    close(code?: number) {
      this.closes.push(code ?? 1000);
    }

    bufferedAmount() {
      return this.#buffered;
    }
  }

  function bridge(connection: CustomConnection): ConnectionDescriptor {
    let descriptor: ConnectionDescriptor | undefined;
    createConnectionBridge({
      engine: {
        accept(_token, accepted) {
          descriptor = accepted;
          return {} as never;
        },
      },
      token: connection,
      transport: connection,
      decision: { userId: 'kofi' },
    });

    return descriptor!;
  }

  it('stores the waiting rows before its own send runs', () => {
    const connection = new CustomConnection();
    const order: string[] = [];
    nodeWriteGate.beforeNextWrite(() => {
      order.push(`commit with ${connection.sent.length} sent`);
      return true;
    });

    bridge(connection).send(hello);

    expect(order).toEqual(['commit with 0 sent']);
    expect(connection.sent).toEqual(['hello']);
  });

  it('closes instead of sending when the commit fails', async () => {
    const connection = new CustomConnection();
    nodeWriteGate.beforeNextWrite(() => false);

    expect(bridge(connection).send(hello)).toBe(false);
    expect(connection.sent).toEqual([]);
    expect(connection.closes).toEqual([1011]);
    await Promise.resolve();
  });

  it('leaves the commit to a transport that holds its frames and gates its own writes', async () => {
    const connection = gatesItsOwnWrites(new CustomConnection());
    const commit = vi.fn(() => true);
    nodeWriteGate.beforeNextWrite(commit);

    bridge(connection).send(hello);

    expect(commit).not.toHaveBeenCalled();
    expect(connection.sent).toEqual(['hello']);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('keeps the connection’s own members, private fields included', () => {
    const descriptor = bridge(new CustomConnection());

    expect(descriptor.bufferedAmount()).toBe(3);
    expect(descriptor.backpressureSupported).toBe(true);
  });
});
