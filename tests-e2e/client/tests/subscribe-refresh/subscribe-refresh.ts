import { channels, client, connect, reconnection } from '@livething/client';
import type { ChannelCheckCommitClient } from '@livething/tests-e2e-handlers/channel-check-commit';
import {
  button,
  el,
  errorCode,
  mount,
  OFFLINE_WINDOW_MAX_DELAY,
  ready,
  wsUrl,
} from '../_shared.ts';

// Drives @livething/client's channel subscribe-payload refresh against the real
// `channel-check-commit` handler's `nonce-room` — a check that rejects a token
// it has already seen. A value payload is a frozen snapshot, resent verbatim on
// reconnect (and refused as reused); a function payload is re-run on reconnect,
// producing a fresh token the check admits.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-static">sub-static</button>
    <button data-testid="sub-fn">sub-fn</button>
    <button data-testid="drop">drop</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="sub-failed"></span>
    <span data-testid="fn-calls"></span>
  `);

  const socket = client<ChannelCheckCommitClient>()(
    connect(wsUrl('channel-check-commit')),
    channels(),
    reconnection({ maxDelay: OFFLINE_WINDOW_MAX_DELAY }),
  );

  const room = socket.channel('nonce-room');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  let subscribed = 0;
  room.onSubscribed(() => {
    subscribed += 1;
    el('subscribed').textContent = String(subscribed);
  });
  room.onSubscriptionFailed((err) => {
    el('sub-failed').textContent = errorCode(err) || 'failed';
  });

  let fnCalls = 0;

  button('connect', () => socket.connect());

  button('sub-static', () => {
    // A frozen token — resent verbatim on reconnect, where the nonce check
    // refuses it as already used.
    void room.subscribe({ token: 'static-token' });
  });

  button('sub-fn', () => {
    // A function — re-run on each reconnect, producing a fresh token.
    void room.subscribe(() => {
      fnCalls += 1;
      el('fn-calls').textContent = String(fnCalls);
      return { token: `nonce-${fnCalls}` };
    });
  });

  button('drop', () => {
    socket.send('server-drop', {});
  });

  el('subscribed').textContent = '0';
  el('fn-calls').textContent = '0';
  ready();
}

setup();
