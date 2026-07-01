import { client, connect, intercept } from '@wskit/client';
import { Block } from '@wskit/client/errors';
import type { InterceptClient } from '@wskit/tests-e2e-handlers/intercept';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's intercept() against the real `intercept` handler, typed
// by the same contract the server implements (InterceptClient =
// InferClient<handler>). The client sends `echo` and the server replies with
// `echoed` carrying { text: `top:<sent>` } — that reply is the INCOMING frame
// the client-side intercepts transform before on('echoed') sees it. The sent
// text selects which behaviour fires, so each test stays independent.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="send-rewrite">send-rewrite</button>
    <button data-testid="send-block">send-block</button>
    <button data-testid="send-order">send-order</button>
    <button data-testid="send-pass">send-pass</button>
    <span data-testid="status"></span>
    <span data-testid="echoed"></span>
  `);

  const socket = client<InterceptClient>()(
    connect(wsUrl('intercept')),
    // First intercept: rewrites the matching incoming payload, drops the block
    // marker, and stamps order '-1' so declaration order can be proven.
    intercept((message) => {
      if (message.event !== 'echoed') return;
      const payload = message.payload as { text: string };
      if (payload.text === 'top:rewrite-me') {
        return { ...message, payload: { text: 'rewritten-by-client' } };
      }
      if (payload.text === 'top:block-me') throw Block;
      if (payload.text === 'top:order-me') {
        return { ...message, payload: { text: `${payload.text}-1` } };
      }
    }),
    // Second intercept: only stamps order '-2'. It must run after the first and
    // never see a blocked frame.
    intercept((message) => {
      if (message.event !== 'echoed') return;
      const payload = message.payload as { text: string };
      if (payload.text === 'top:order-me-1') {
        return { ...message, payload: { text: `${payload.text}-2` } };
      }
    }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('echoed', (data) => {
    el('echoed').textContent = data.text;
  });

  button('connect', () => socket.connect());

  button('send-rewrite', () => {
    socket.send('echo', { text: 'rewrite-me' });
  });

  button('send-block', () => {
    socket.send('echo', { text: 'block-me' });
  });

  button('send-order', () => {
    socket.send('echo', { text: 'order-me' });
  });

  button('send-pass', () => {
    socket.send('echo', { text: 'pass-me' });
  });

  ready();
}

setup();
