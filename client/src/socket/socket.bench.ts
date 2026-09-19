import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { debug as debugMode } from '~/primitives/debug.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { bench, describe } from 'vitest';
import type { SocketContract } from '~/types.ts';

interface Contract extends SocketContract {
  incoming: {
    message: { text: string; from: string };
    presence: { online: number };
    tick: { at: number };
  };
  outgoing: {
    typing: { on: boolean };
  };
  channels: {
    room: {
      incoming: { post: { text: string } };
      outgoing: { post: { text: string } };
    };
  };
}

function connected(debug: boolean) {
  const restore = installMockWebSocket();
  const socket = client<Contract>()(
    connect('wss://bench'),
    debugMode(debug),
    channels(),
    clientRequests(),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  socket.on('message', () => {});
  socket.on('presence', () => {});

  return { socket, ws, restore };
}

/** A realistic inbound mix: mostly plain user events, some channel traffic. */
function trafficFor(count: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 5 === 0) {
      frames.push(JSON.stringify(['post', { text: `m${i}` }, { channel: { name: 'room' } }]));
    } else if (i % 5 === 1) {
      frames.push(JSON.stringify(['presence', { online: i }, null]));
    } else {
      frames.push(JSON.stringify(['message', { text: `m${i}`, from: 'u-1' }, null]));
    }
  }

  return frames;
}

// The whole inbound path: onmessage → parse → primitive onIncoming chain →
// protocol-frame check → top-level or channel dispatch.
describe('inbound dispatch · 100k frames', () => {
  const frames = trafficFor(100_000);

  const quiet = connected(false);
  bench('debug off (the shipping default)', () => {
    for (const data of frames) quiet.ws.onmessage!({ data });
  });

  const noisy = connected(true);
  const sink = { log: console.log, warn: console.warn, error: console.error };
  bench('debug on', () => {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      for (const data of frames) noisy.ws.onmessage!({ data });
    } finally {
      Object.assign(console, sink);
    }
  });
});

// The outbound path: onOutgoing chain → buffering fallback → serialize → write.
describe('outbound send · 100k sends', () => {
  const { socket } = connected(false);

  bench('top-level send', () => {
    for (let i = 0; i < 100_000; i++) socket.send('typing', { on: true });
  });
});

// Building a socket is not per-frame work, but an app that creates one per route
// or per test pays it often.
describe('socket construction', () => {
  bench('client() with channels + clientRequests', () => {
    const restore = installMockWebSocket();
    client<Contract>()(connect('wss://bench'), channels(), clientRequests());
    restore();
  });
});
