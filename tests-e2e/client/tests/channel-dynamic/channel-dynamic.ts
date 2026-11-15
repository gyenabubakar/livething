import { channels, client, connect } from '@livething/client';
import type { ChannelDynamicClient } from '@livething/tests-e2e-handlers/channel-dynamic';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client's channels() against the real `channel-dynamic` server definition,
// exercising the dynamic-family surface: socket.channel(scope, name) and the
// socket.channel.scope(scope) handle, typed by the same contract the server
// implements (ChannelDynamicClient = InferClient<definition>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-general">sub-general</button>
    <button data-testid="sub-vip">sub-vip</button>
    <button data-testid="sub-via-scope">sub-via-scope</button>
    <button data-testid="sub-bad-name">sub-bad-name</button>
    <button data-testid="send-general">send-general</button>
    <button data-testid="fail-general">fail-general</button>
    <button data-testid="echo-general">echo-general</button>
    <span data-testid="status"></span>
    <span data-testid="sub-general-ok"></span>
    <span data-testid="sub-vip-ok"></span>
    <span data-testid="sub-via-scope-ok"></span>
    <span data-testid="sub-error"></span>
    <span data-testid="user-msgs-general"></span>
    <span data-testid="user-msgs-vip"></span>
    <span data-testid="name-result"></span>
    <span data-testid="subscription-failed"></span>
    <span data-testid="server-error"></span>
  `);

  const page = new URLSearchParams(location.search);
  const lazy = page.get('lazy') === 'true';
  const probe = page.get('probe');
  const socket = client<ChannelDynamicClient>()(
    connect(wsUrl('channel-dynamic'), lazy ? { lazy: true, lazyIdleTimeoutMs: 500 } : undefined),
    channels(),
  );

  const rooms = socket.channel.family('room');
  const general = socket.channel('room', 'room:general');
  const vip = rooms('room:vip');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  function append(testid: string, value: string): void {
    const span = el(testid);
    span.textContent = span.textContent ? `${span.textContent},${value}` : value;
  }

  if (!probe) {
    general.on('room-message', (data) => {
      if (data.kind === 'user') append('user-msgs-general', `${data.from}:${data.text}`);
    });
    vip.on('room-message', (data) => {
      if (data.kind === 'user') append('user-msgs-vip', `${data.from}:${data.text}`);
    });
    general.on('name-result', (data) => {
      el('name-result').textContent = `${data.name}|${data.suffix}`;
    });
  }

  general.onSubscriptionFailed(() => {
    el('subscription-failed').textContent = 'yes';
  });

  socket.onServerError((error) => {
    el('server-error').textContent = error.code;
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
  button('fail-general', () => {
    general.send('trigger-manual-validation', {});
  });
  button('echo-general', () => {
    general.send('echo-name', {});
  });

  ready();
}

setup();
