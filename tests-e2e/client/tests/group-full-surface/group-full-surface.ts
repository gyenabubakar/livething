import { channels, client, clientRequests, connect, dedup, stream } from '@wskit/client';
import type { GroupFullSurfaceClient } from '@wskit/tests-e2e-handlers/group-full-surface';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives a broad smoke across @wskit/client primitives against the real
// `group-full-surface` handler, typed by the same contract the server
// implements (GroupFullSurfaceClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="lookup">lookup</button>
    <button data-testid="feed">feed</button>
    <button data-testid="sub-rooms">sub-rooms</button>
    <button data-testid="send-msg">send-msg</button>
    <span data-testid="status"></span>
    <span data-testid="welcome"></span>
    <span data-testid="lookup-hit"></span>
    <span data-testid="feed-chunks"></span>
    <span data-testid="feed-end"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="room-msg"></span>
  `);

  const socket = client<GroupFullSurfaceClient>()(
    connect(wsUrl('group-full-surface')),
    clientRequests(),
    stream(),
    channels(),
    dedup(),
  );

  const rooms = socket.channel('rooms');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('welcome', (data) => {
    el('welcome').textContent = data.username;
  });

  rooms.on('room-msg', (data) => {
    el('room-msg').textContent = `${data.from}:${data.text}`;
  });

  button('connect', () => socket.connect());

  button('lookup', async () => {
    const res = await socket.request('lookup', { id: 'abc' });
    el('lookup-hit').textContent = res.found ? res.hit : '';
  });

  button('feed', async () => {
    el('feed-chunks').textContent = '';
    el('feed-end').textContent = 'no';
    const handle = await socket.stream('feed', {});
    const indices: number[] = [];
    for await (const chunk of handle) {
      indices.push(chunk.idx);
      el('feed-chunks').textContent = indices.join(',');
    }
    el('feed-end').textContent = 'yes';
  });

  button('sub-rooms', async () => {
    await rooms.subscribe();
    el('subscribed').textContent = 'yes';
  });

  button('send-msg', () => {
    rooms.send('send-msg', { text: 'hello room' });
  });

  ready();
}

setup();
