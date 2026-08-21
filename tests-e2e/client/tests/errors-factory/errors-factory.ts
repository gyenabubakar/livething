import { client, connect } from '@wskit/client';
import { WSKitError } from '@wskit/client/errors';
import type { ErrorsFactoryClient } from '@wskit/tests-e2e-handlers/errors-factory';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's base socket against the real `errors-factory` handler.
// Server errors that no request or stream claims surface on socket.onServerError
// as a typed WSKitError — every trigger here is a fire-and-forget incoming event,
// so the error always arrives that way.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="trigger-not-found">trigger-not-found</button>
    <button data-testid="trigger-forbidden">trigger-forbidden</button>
    <button data-testid="trigger-simple">trigger-simple</button>
    <button data-testid="trigger-unregistered">trigger-unregistered</button>
    <button data-testid="trigger-bigint">trigger-bigint</button>
    <span data-testid="status"></span>
    <span data-testid="error-code"></span>
    <span data-testid="error-result"></span>
    <span data-testid="specific-error-code"></span>
    <span data-testid="specific-error-detail"></span>
    <span data-testid="unmatched-specific-error"></span>
  `);

  const socket = client<ErrorsFactoryClient>()(connect(wsUrl('errors-factory')));

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.onServerError((err) => {
    if (!(err instanceof WSKitError)) return;
    el('error-code').textContent = errorCode(err);
    el('error-result').textContent = `${err.code}:${JSON.stringify(err.detail ?? {})}`;
  });

  socket.onServerError('not-found', (err) => {
    el('specific-error-code').textContent = err.code;
    el('specific-error-detail').textContent = err.detail.id;
  });

  socket.onServerError('forbidden', (err) => {
    el('unmatched-specific-error').textContent = err.code;
  });

  button('connect', () => socket.connect());

  button('trigger-not-found', () => {
    socket.send('trigger-not-found', {});
  });

  button('trigger-forbidden', () => {
    socket.send('trigger-forbidden', {});
  });

  button('trigger-simple', () => {
    socket.send('trigger-simple', {});
  });

  button('trigger-unregistered', () => {
    socket.send('trigger-unregistered', {});
  });

  button('trigger-bigint', () => {
    socket.send('trigger-bigint', {});
  });

  ready();
}

setup();
