import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { bench, describe } from 'vitest';
import type { SocketContract } from '~/types.ts';

interface Contract extends SocketContract {
  channels: {
    room: {
      incoming: { post: { text: string } };
      outgoing: { post: { text: string } };
    };
    thread: {
      addressing: 'dynamic';
      incoming: { post: { text: string } };
    };
  };
}

const ROOMS = 16;

function connected() {
  installMockWebSocket();
  const socket = client<Contract>()(connect('wss://bench'), channels());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  const room = socket.channel('room');
  void room.subscribe();
  ws.onmessage!({
    data: JSON.stringify(['__subscribeOk__', null, { channel: { name: 'room' } }]),
  });
  room.on('post', () => {});

  for (let i = 0; i < ROOMS; i++) {
    const member = socket.channel('thread', `t-${i}`);
    void member.subscribe();
    ws.onmessage!({
      data: JSON.stringify([
        '__subscribeOk__',
        null,
        { channel: { name: `t-${i}`, family: 'thread' } },
      ]),
    });
    member.on('post', () => {});
  }

  return { socket, ws };
}

function staticTraffic(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify(['post', { text: `m${i}` }, { channel: { name: 'room' } }]),
  );
}

function familyTraffic(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify([
      'post',
      { text: `m${i}` },
      { channel: { name: `t-${i % ROOMS}`, family: 'thread' } },
    ]),
  );
}

// Routing an inbound channel frame: build the state key, resolve the plugin
// event prefix, dispatch to the channel and (for a family member) the family.
describe('channel routing · 100k frames', () => {
  const { ws } = connected();
  const staticFrames = staticTraffic(100_000);
  const familyFrames = familyTraffic(100_000);

  bench('static channel', () => {
    for (const data of staticFrames) ws.onmessage!({ data });
  });

  bench('family-scoped channel over 16 members', () => {
    for (const data of familyFrames) ws.onmessage!({ data });
  });
});
