import { channels, client, connect, reconnection, stream } from '@livething/client';
import type { StreamDurableBroadcastClient } from '@livething/tests-e2e-handlers/stream-durable-broadcast';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives a recorded broadcast stream (`feed`, 5 chunks 250 ms apart) in the
// 'rooms' channel across a peer's reconnect. The peer listens with onStream,
// drops its socket mid-stream, reconnects (persistent channel rejoin), then
// resumes the stream by ID. Every chunk each surface receives is logged, so the
// spec can prove whether any chunk reaches the same listener twice.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="subscribe">subscribe</button>
    <button data-testid="listen">listen</button>
    <button data-testid="start">start</button>
    <button data-testid="drop">drop</button>
    <button data-testid="resume">resume</button>
    <span data-testid="status"></span>
    <span data-testid="sub-ok"></span>
    <span data-testid="trigger-chunks"></span>
    <span data-testid="trigger-end"></span>
    <span data-testid="peer-chunks"></span>
    <span data-testid="peer-end"></span>
    <span data-testid="resume-chunks"></span>
    <span data-testid="resume-end"></span>
  `);

  const socket = client<StreamDurableBroadcastClient>()(
    connect(wsUrl('stream-durable-broadcast')),
    reconnection({ maxDelay: 200 }),
    channels(),
    stream(),
  );
  const room = socket.channel('rooms');
  let streamId: string | null = null;

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  function append(testid: string, value: string): void {
    const span = el(testid);
    span.textContent = span.textContent ? `${span.textContent},${value}` : value;
  }

  button('connect', () => socket.connect());

  button('subscribe', async () => {
    await room.subscribe();
    el('sub-ok').textContent = 'yes';
  });

  button('listen', () => {
    room.onStream('feed', {
      onChunk: (chunk, id) => {
        streamId = id;
        append('peer-chunks', chunk.token);
      },
      onEnd: () => {
        el('peer-end').textContent = 'yes';
      },
    });
  });

  button('start', async () => {
    const handle = await room.stream('feed', {});
    for await (const chunk of handle) append('trigger-chunks', chunk.token);
    el('trigger-end').textContent = 'yes';
  });

  // Close the raw socket with a non-normal code: the client treats it as an
  // unexpected drop, and reconnection() opens a new socket.
  button('drop', () => {
    socket.ws?.close(4000, 'test drop');
  });

  button('resume', async () => {
    if (!streamId) return;

    const handle = room.resumeStream('feed', streamId);
    for await (const chunk of handle) append('resume-chunks', chunk.token);
    el('resume-end').textContent = 'yes';
  });

  ready();
}

setup();
