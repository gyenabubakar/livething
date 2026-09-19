import { client, clientRequests, connect } from '@livething/client';
import { LiveThingError } from '@livething/client/errors';
import type { RateLimitClient } from '@livething/tests-e2e-handlers/rate-limit';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client against the real `rate-limit` server definition. Fire-and-forget
// events that breach a cap carry no correlationId, so the server's `__error__`
// frame surfaces on socket.onServerError as a typed LiveThingError; a rate-limited
// request() rejects with the same code instead.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="tick">tick</button>
    <button data-testid="expensive">expensive</button>
    <button data-testid="echo-req">echo-req</button>
    <span data-testid="status"></span>
    <span data-testid="error-code"></span>
    <span data-testid="retry-after-ms"></span>
    <span data-testid="echo-outcome"></span>
  `);

  const socket = client<RateLimitClient>()(connect(wsUrl('rate-limit')), clientRequests());

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.onServerError((err) => {
    if (!(err instanceof LiveThingError)) return;

    el('error-code').textContent = errorCode(err);
    const detail = err.detail as { retryAfterMs?: number } | undefined;
    if (typeof detail?.retryAfterMs === 'number') {
      el('retry-after-ms').textContent = String(detail.retryAfterMs);
    }
  });

  button('connect', () => socket.connect());

  button('tick', () => {
    socket.send('tick', {});
  });

  button('expensive', () => {
    socket.send('expensive', {});
  });

  button('echo-req', async () => {
    try {
      await socket.request('echo-req', { text: 'hi' });
      el('echo-outcome').textContent = 'ok';
    } catch (err) {
      el('echo-outcome').textContent = errorCode(err);
    }
  });

  ready();
}

setup();
