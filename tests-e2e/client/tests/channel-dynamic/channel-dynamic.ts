import { channels, client, connect } from '@wskit/client';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// GAP: InferClient collapses the server's scope('room','room:{id}') family into a
// FIXED 'room' channel, so the handler's ChannelDynamicClient cannot type the
// dynamic-family API (channel(scope, name) / channel.scope). Until that gap is
// closed, this page types the family locally to drive the real dynamic channel;
// the event shapes mirror the handler's contract exactly.
interface RoomFamilyEvents {
  incoming: {
    'room-message': { channel: string; text: string; from: string; kind: string };
    'name-result': { name: string; suffix: string };
  };
  outgoing: {
    'send-message': { text: string };
    'echo-name': Record<string, never>;
  };
}
interface ChannelDynamicContract {
  channels: { room: { [name: string]: RoomFamilyEvents } };
}

// Drives @wskit/client's channels() against the real `channel-dynamic` handler,
// exercising the dynamic-family surface: socket.channel(scope, name) and the
// socket.channel.scope(scope) handle, typed by the same contract the server
// implements (ChannelDynamicClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-general">sub-general</button>
    <button data-testid="sub-vip">sub-vip</button>
    <button data-testid="sub-via-scope">sub-via-scope</button>
    <button data-testid="sub-bad-name">sub-bad-name</button>
    <button data-testid="send-general">send-general</button>
    <button data-testid="echo-general">echo-general</button>
    <span data-testid="status"></span>
    <span data-testid="sub-general-ok"></span>
    <span data-testid="sub-vip-ok"></span>
    <span data-testid="sub-via-scope-ok"></span>
    <span data-testid="sub-error"></span>
    <span data-testid="user-msgs-general"></span>
    <span data-testid="user-msgs-vip"></span>
    <span data-testid="name-result"></span>
  `);

  const socket = client<ChannelDynamicContract>()(connect(wsUrl('channel-dynamic')), channels());

  const rooms = socket.channel.scope('room');
  const general = socket.channel('room', 'room:general');
  const vip = rooms('room:vip');

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  function append(testid: string, value: string): void {
    const span = el(testid);
    span.textContent = span.textContent ? `${span.textContent},${value}` : value;
  }

  general.on('room-message', (data) => {
    if (data.kind === 'user') append('user-msgs-general', `${data.from}:${data.text}`);
  });
  vip.on('room-message', (data) => {
    if (data.kind === 'user') append('user-msgs-vip', `${data.from}:${data.text}`);
  });
  general.on('name-result', (data) => {
    el('name-result').textContent = `${data.name}|${data.suffix}`;
  });

  button('connect', () => socket.connect());

  button('sub-general', async () => {
    await general.subscribe();
    el('sub-general-ok').textContent = 'room:general';
  });

  button('sub-vip', async () => {
    await vip.subscribe();
    el('sub-vip-ok').textContent = 'room:vip';
  });

  button('sub-via-scope', async () => {
    await rooms('room:general').subscribe();
    el('sub-via-scope-ok').textContent = 'room:general';
  });

  button('sub-bad-name', async () => {
    try {
      await socket.channel('room', 'admin').subscribe();
    } catch (err) {
      el('sub-error').textContent = errorCode(err);
    }
  });

  button('send-general', () => {
    general.send('send-message', { text: 'hello-general' });
  });
  button('echo-general', () => {
    general.send('echo-name', {});
  });

  ready();
}

setup();
