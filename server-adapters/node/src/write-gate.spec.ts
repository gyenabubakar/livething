import { describe, expect, it, vi } from 'vitest';
import type { ConnectionDescriptor, TransportFrame } from '@livething/server/adapters';
import { createConnectionBridge } from './socket.ts';
import { gatesItsOwnWrites, NodeWriteGate, onWriteGateFailure } from './write-gate.ts';

const hello: TransportFrame = { kind: 'text', text: 'hello', shared: false };

describe('the Node write gate', () => {
  it('runs a waiting commit once, before the next write', () => {
    const gate = new NodeWriteGate();
    const commit = vi.fn(() => true);
    gate.beforeNextWrite(commit);

    expect(gate.commitBeforeWrite()).toBe(true);
    expect(gate.commitBeforeWrite()).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('runs a waiting commit at the end of a turn that writes nothing', async () => {
    const gate = new NodeWriteGate();
    const commit = vi.fn(() => true);
    gate.beforeNextWrite(commit);

    await new Promise((resolve) => setImmediate(resolve));

    expect(commit).toHaveBeenCalledOnce();
  });

  it('reports a failed commit, and a commit that throws, to the failure drops', async () => {
    const gate = new NodeWriteGate();
    const drop = vi.fn();
    onWriteGateFailure(drop);
    gate.beforeNextWrite(() => false);

    expect(gate.commitBeforeWrite()).toBe(false);
    expect(drop).toHaveBeenCalledExactlyOnceWith(gate);

    await Promise.resolve();
    gate.beforeNextWrite(() => {
      throw new Error('disk full');
    });

    expect(gate.commitBeforeWrite()).toBe(false);
    expect(drop).toHaveBeenCalledTimes(2);
  });

  it('refuses every other write of the same broadcast after a failed commit', async () => {
    const gate = new NodeWriteGate();
    gate.beforeNextWrite(() => false);

    expect(gate.commitBeforeWrite()).toBe(false);
    expect(gate.commitBeforeWrite()).toBe(false);
    expect(gate.commitNow()).toBe(false);

    await Promise.resolve();
    expect(gate.commitBeforeWrite()).toBe(true);
  });

  it('refuses no write of another endpoint after a failed commit', async () => {
    const huddle = new NodeWriteGate();
    const standup = new NodeWriteGate();
    huddle.beforeNextWrite(() => false);

    expect(huddle.commitBeforeWrite()).toBe(false);
    expect(standup.failed).toBe(false);
    expect(standup.commitBeforeWrite()).toBe(true);
    await Promise.resolve();
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

  function bridge(connection: CustomConnection, writeGate: NodeWriteGate): ConnectionDescriptor {
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
      writeGate,
    });

    return descriptor!;
  }

  it('stores the waiting rows before its own send runs', () => {
    const gate = new NodeWriteGate();
    const connection = new CustomConnection();
    const order: string[] = [];
    gate.beforeNextWrite(() => {
      order.push(`commit with ${connection.sent.length} sent`);
      return true;
    });

    bridge(connection, gate).send(hello);

    expect(order).toEqual(['commit with 0 sent']);
    expect(connection.sent).toEqual(['hello']);
  });

  it('closes instead of sending when the commit fails', async () => {
    const gate = new NodeWriteGate();
    const connection = new CustomConnection();
    gate.beforeNextWrite(() => false);

    expect(bridge(connection, gate).send(hello)).toBe(false);
    expect(connection.sent).toEqual([]);
    expect(connection.closes).toEqual([1011]);
    await Promise.resolve();
  });

  it('gives its gate to a transport that holds its frames and gates its own writes', async () => {
    const gate = new NodeWriteGate();
    const given: NodeWriteGate[] = [];
    const connection = gatesItsOwnWrites(new CustomConnection(), (own) => given.push(own));
    const commit = vi.fn(() => true);
    gate.beforeNextWrite(commit);

    bridge(connection, gate).send(hello);

    expect(given).toEqual([gate]);
    expect(commit).not.toHaveBeenCalled();
    expect(connection.sent).toEqual(['hello']);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('keeps the connection’s own members, private fields included', () => {
    const descriptor = bridge(new CustomConnection(), new NodeWriteGate());

    expect(descriptor.bufferedAmount()).toBe(3);
    expect(descriptor.backpressureSupported).toBe(true);
  });
});
