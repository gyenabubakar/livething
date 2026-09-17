import { channels, client, connect } from '@wskit/client';
import type { ChannelCheckCommitClient } from '@wskit/tests-e2e-handlers/channel-check-commit';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's channel subscribe (check + commit) against the real
// `channel-check-commit` handler, typed by the same contract the server
// implements (ChannelCheckCommitClient = InferClient<definition>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-member">sub-member</button>
    <button data-testid="sub-unknown">sub-unknown</button>
    <button data-testid="sub-banned">sub-banned</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="subscribe-error"></span>
  `);

  const socket = client<ChannelCheckCommitClient>()(
    connect(wsUrl('channel-check-commit')),
    channels(),
  );

  const room = socket.channel('room');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  room.onSubscribed(() => {
    el('subscribed').textContent = 'yes';
  });

  button('connect', () => socket.connect());

  async function trySubscribe(token: string): Promise<void> {
    try {
      await room.subscribe({ token });
    } catch (err) {
      el('subscribe-error').textContent = errorCode(err);
    }
  }

  button('sub-member', () => trySubscribe('tok-member'));
  button('sub-unknown', () => trySubscribe('tok-unknown'));
  button('sub-banned', () => trySubscribe('tok-banned'));

  ready();
}

setup();
