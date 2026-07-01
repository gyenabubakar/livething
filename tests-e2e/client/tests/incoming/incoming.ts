import { client, connect } from '@wskit/client';
import type { IncomingClient } from '@wskit/tests-e2e-handlers/incoming';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's base on()/send() against the real `incoming` handler,
// typed by the same contract the server implements (IncomingClient =
// InferClient<handler>). The handler's incoming events are the client's
// outgoing (send), and its outgoing events are the client's incoming (on).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="ping">ping</button>
    <button data-testid="ping-bad">ping-bad</button>
    <button data-testid="anything">anything</button>
    <button data-testid="unhandled">unhandled</button>
    <span data-testid="status"></span>
    <span data-testid="pong"></span>
    <span data-testid="handlers"></span>
    <span data-testid="error-code"></span>
    <span data-testid="error-event"></span>
  `);

  const socket = client<IncomingClient>()(connect(wsUrl('incoming')));

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.onError((err: unknown) => {
    el('error-code').textContent = errorCode(err);
  });

  // Three handlers for one event; the middle one throws. A conforming client
  // isolates the throw so the other two still run and record their order.
  const order: string[] = [];
  socket.on('echo-pong', (data) => {
    order.push('A');
    el('pong').textContent = data.text;
    el('handlers').textContent = order.join('');
  });
  socket.on('echo-pong', () => {
    order.push('B');
    el('handlers').textContent = order.join('');
    throw new Error('boom');
  });
  socket.on('echo-pong', () => {
    order.push('C');
    el('handlers').textContent = order.join('');
  });

  socket.on('validation-error-fired', (data) => {
    el('error-event').textContent = data.event;
  });

  button('connect', () => socket.connect());

  button('ping', () => {
    socket.send('echo-ping', { text: 'hello' });
  });

  // A bad outgoing payload: echo-ping wants { text: string }. Cast the payload
  // (not the method — that would lose `this`) so the server's validator rejects
  // it on the wire and the __error__ routes to onError.
  button('ping-bad', () => {
    socket.send('echo-ping', { text: 123 } as unknown as { text: string });
  });

  // Schemaless outgoing: the server echoes whatever it gets back as anything-echo,
  // which has no on() handler here, so the client must silently ignore it.
  button('anything', () => {
    socket.send('echo-anything', { nested: { x: true }, list: [1, 2, 3] });
  });

  // An incoming event the client never registered an on() for is silently
  // dropped; echo-ping then proves the connection still dispatches normally.
  button('unhandled', () => {
    socket.send('echo-ping', { text: 'hello' });
  });

  ready();
}

setup();
