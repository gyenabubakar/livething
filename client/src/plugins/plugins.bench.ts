import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { bench, describe } from 'vitest';
import type { SocketContract } from '~/types.ts';

interface Wire extends SocketContract {
  incoming: { tick: { n: number } };
}

const ids = ['acme:a', 'acme:b', 'acme:c', 'acme:d', 'acme:e'] as const;

/** Five plugins, each owning a namespace; one of them also runs an onIncoming hook. */
const plugins = ids.map((id, index) =>
  plugin<Wire>()({
    id,
    setup(socket) {
      socket.on('tick', () => {});
      if (index === 0) socket.onIncoming((message) => message);
      return {};
    },
  }),
);

interface AppContract extends SocketContract {
  incoming: {
    message: { text: string };
    '__acme:a::tick': { n: number };
    '__acme:b::tick': { n: number };
    '__acme:c::tick': { n: number };
    '__acme:d::tick': { n: number };
    '__acme:e::tick': { n: number };
  };
}

function connected() {
  installMockWebSocket();
  const socket = client<AppContract>()(
    connect('wss://bench'),
    plugins[0]!(),
    plugins[1]!(),
    plugins[2]!(),
    plugins[3]!(),
    plugins[4]!(),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  socket.on('message', () => {});
  return ws;
}

/** Mixed traffic: plain app frames plus frames owned by each plugin namespace. */
function trafficFor(count: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      i % 2 === 0
        ? JSON.stringify({ event: 'message', payload: { text: `m${i}` } })
        : JSON.stringify({ event: `__${ids[i % 5]}::tick`, payload: { n: i } }),
    );
  }
  return frames;
}

// With plugins registered, every frame walks all five plugin onIncoming hooks:
// namespace match, then either dispatch or pass on.
describe('plugin pipeline · 100k frames through 5 plugins', () => {
  const ws = connected();
  const frames = trafficFor(100_000);

  bench('mixed app + plugin traffic', () => {
    for (const data of frames) ws.onmessage!({ data });
  });
});
