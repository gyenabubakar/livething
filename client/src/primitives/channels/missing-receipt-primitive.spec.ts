import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { readReceipts } from '~/primitives/inbox/read-receipts.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveThingMetadata } from '~/internal/runtime.ts';
import type { Primitive } from '~/primitives/types.ts';

interface C {
  channels: {
    room: {
      incoming: { msg: { text: string } };
      inbox: true;
      readReceipts: true;
    };
  };
}

function build(extraPrimitives: Primitive[], debug: boolean) {
  const socket = client<C>()(
    connect('wss://test'),
    channels(),
    dedup(),
    ...(extraPrimitives as []),
  );
  socket.setDebug(debug);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

function subscribeOk(
  ws: MockWebSocket,
  channel: string,
  flags: Omit<NonNullable<LiveThingMetadata['channel']>, 'name'>,
) {
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    metadata: { exchange: { source: 'client' }, channel: { name: channel, ...flags } },
  });
}

function warningsMatching(warn: ReturnType<typeof vi.spyOn>, needle: string): unknown[][] {
  return (warn.mock.calls as unknown[][]).filter((call) =>
    call.some((arg) => String(arg).includes(needle)),
  );
}

let restore: () => void;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  restore = installMockWebSocket();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  restore();
});

describe('channels — missing receipt-primitive warning', () => {
  it('warns when a channel is inbox-backed but inbox() is not registered', () => {
    const { ws } = build([], true);
    subscribeOk(ws, 'room', { inbox: true });

    expect(warningsMatching(warn, 'inbox() is not registered')).toHaveLength(1);
  });

  it('warns when readReceipts is enabled but readReceipts() is not registered', () => {
    const { ws } = build([], true);
    subscribeOk(ws, 'room', { readReceipts: true });

    expect(warningsMatching(warn, 'readReceipts() is not registered')).toHaveLength(1);
  });

  it('warns at most once per channel across repeated subscribes', () => {
    const { ws } = build([], true);
    subscribeOk(ws, 'room', { inbox: true });
    subscribeOk(ws, 'room', { inbox: true });
    subscribeOk(ws, 'room', { inbox: true });

    expect(warningsMatching(warn, 'inbox() is not registered')).toHaveLength(1);
  });

  it('does not warn when inbox() is registered', () => {
    const { ws } = build([inbox()], true);
    subscribeOk(ws, 'room', { inbox: true });

    expect(warningsMatching(warn, 'inbox() is not registered')).toHaveLength(0);
  });

  it('does not warn when readReceipts() is registered', () => {
    const { ws } = build([inbox(), readReceipts()], true);
    subscribeOk(ws, 'room', { readReceipts: true });

    expect(warningsMatching(warn, 'readReceipts() is not registered')).toHaveLength(0);
  });

  it('does not warn when debug is off', () => {
    const { ws } = build([], false);
    subscribeOk(ws, 'room', { inbox: true, readReceipts: true });

    expect(warningsMatching(warn, 'is not registered')).toHaveLength(0);
  });

  it('does not warn on a plain channel carrying neither flag', () => {
    const { ws } = build([], true);
    subscribeOk(ws, 'room', {});

    expect(warningsMatching(warn, 'is not registered')).toHaveLength(0);
  });
});
