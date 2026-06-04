import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WSKitSocket } from '~/socket/socket.ts';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

/** Build a socket and return its helpers object directly. */
function makeHelpers() {
  const socket = client()(connect('wss://test'));
  return (socket as WSKitSocket)._helpers();
}

describe('onSignal / emitSignal', () => {
  it('unsubscribing stops the handler from receiving later signals', () => {
    const helpers = makeHelpers();
    const received: boolean[] = [];
    const unsub = helpers.onSignal('online', (v: boolean) => received.push(v));

    helpers.emitSignal('online', true);
    expect(received).toEqual([true]);

    unsub();

    helpers.emitSignal('online', false);
    expect(received).toHaveLength(1); // handler did not fire again
  });

  it('emitSignal to a name with no listeners is a safe no-op', () => {
    const helpers = makeHelpers();
    expect(() => helpers.emitSignal('online', true)).not.toThrow();
  });

  it('emitSignal to a name after every subscriber has unsubscribed is a safe no-op', () => {
    const helpers = makeHelpers();
    const unsub = helpers.onSignal('online', () => {});
    unsub();
    expect(() => helpers.emitSignal('online', true)).not.toThrow();
  });

  it('other handlers for the same signal still fire after one is unsubscribed', () => {
    const helpers = makeHelpers();
    const a: boolean[] = [];
    const b: boolean[] = [];
    const unsubA = helpers.onSignal('online', (v: boolean) => a.push(v));
    helpers.onSignal('online', (v: boolean) => b.push(v));

    helpers.emitSignal('online', true);
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);

    unsubA();
    helpers.emitSignal('online', false);
    expect(a).toHaveLength(1); // A stopped
    expect(b).toEqual([true, false]); // B continued
  });
});

describe('generateId', () => {
  it('returns a plain counter string when no prefix is given', () => {
    const helpers = makeHelpers();
    const id = helpers.generateId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^\d+$/);
  });

  it('returns prefix-N when a prefix is given', () => {
    const helpers = makeHelpers();
    const id = helpers.generateId('ack');
    expect(id).toMatch(/^ack-\d+$/);
  });

  it('successive calls produce strictly increasing counters', () => {
    const helpers = makeHelpers();
    const first = Number(helpers.generateId());
    const second = Number(helpers.generateId());
    const third = Number(helpers.generateId());
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('ids are unique across successive calls regardless of prefix', () => {
    const helpers = makeHelpers();
    const ids = [
      helpers.generateId('ack'),
      helpers.generateId('req'),
      helpers.generateId('ack'),
      helpers.generateId(),
    ];
    const underlying = ids.map((id: string) => id.split('-').at(-1));
    const unique = new Set(underlying);
    expect(unique.size).toBe(ids.length);
  });

  it('an ack id and a request id on the same socket never share the same underlying counter value', () => {
    const helpers = makeHelpers();
    const ackId = helpers.generateId('ack');
    const reqId = helpers.generateId('req');
    const ackN = ackId.replace('ack-', '');
    const reqN = reqId.replace('req-', '');
    expect(ackN).not.toBe(reqN);
  });
});
