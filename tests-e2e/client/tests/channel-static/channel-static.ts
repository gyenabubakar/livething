import { channels, client, connect, requestResponse, stream } from '@wskit/client';
import type { ChannelStaticClient } from '@wskit/tests-e2e-handlers/channel-static';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's channels() against the real `channel-static` handler,
// typed by the same contract the server implements
// (ChannelStaticClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-room">sub-room</button>
    <button data-testid="sub-bogus">sub-bogus</button>
    <button data-testid="unsub-room">unsub-room</button>
    <button data-testid="send-hello">send-hello</button>
    <button data-testid="start-stream">start-stream</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="on-subscribed-source"></span>
    <span data-testid="sub-error"></span>
    <span data-testid="user-messages"></span>
    <span data-testid="system-messages"></span>
    <span data-testid="members-count"></span>
    <span data-testid="member-joins"></span>
    <span data-testid="member-leaves"></span>
    <span data-testid="stream-chunks"></span>
    <span data-testid="stream-end"></span>
  `);

  const socket = client<ChannelStaticClient>()(
    connect(wsUrl('channel-static')),
    requestResponse(),
    channels(),
    stream(),
  );

  const room = socket.channel('room');

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  room.onSubscribed((source) => {
    el('on-subscribed-source').textContent = source;
  });

  room.on('room-message', (msg) => {
    const target = msg.kind === 'system' ? 'system-messages' : 'user-messages';
    const line = `${msg.from}:${msg.text}`;
    const span = el(target);
    span.textContent = span.textContent ? `${span.textContent},${line}` : line;
    el('members-count').textContent = String(room.members.size);
  });

  room.onMemberJoin((connectionId) => {
    const span = el('member-joins');
    const entry = `room:${connectionId}`;
    span.textContent = span.textContent ? `${span.textContent},${entry}` : entry;
    el('members-count').textContent = String(room.members.size);
  });

  room.onMemberLeave((connectionId) => {
    const span = el('member-leaves');
    const entry = `room:${connectionId}`;
    span.textContent = span.textContent ? `${span.textContent},${entry}` : entry;
    el('members-count').textContent = String(room.members.size);
  });

  button('connect', () => socket.connect());

  button('sub-room', async () => {
    await room.subscribe();
    el('subscribed').textContent = 'yes';
    el('members-count').textContent = String(room.members.size);
  });

  button('sub-bogus', async () => {
    try {
      // The typed contract only allows 'room' | 'room2'; cast to exercise the
      // server's channel-not-found rejection reaching the subscribe() promise.
      await socket.channel('does-not-exist' as 'room').subscribe();
    } catch (err) {
      el('sub-error').textContent = errorCode(err);
    }
  });

  button('unsub-room', () => {
    room.unsubscribe();
    el('subscribed').textContent = 'no';
  });

  button('send-hello', () => {
    room.send('send-message', { text: 'hello' });
  });

  button('start-stream', async () => {
    const chunks: number[] = [];
    const handle = await room.stream('start-channel-stream', { count: 3 });
    for await (const chunk of handle) {
      chunks.push(chunk.index);
      el('stream-chunks').textContent = chunks.join(',');
    }
    el('stream-end').textContent = 'yes';
  });

  ready();
}

setup();
