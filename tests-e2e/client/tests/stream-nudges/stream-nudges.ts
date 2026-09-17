import { client, connect, stream } from '@wskit/client';
import type { StreamNudgesClient } from '@wskit/tests-e2e-handlers/stream-nudges';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's stream().nudge() against the real `stream-nudges`
// server definition, typed by the same contract the server implements
// (StreamNudgesClient = InferClient<definition>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start">start</button>
    <button data-testid="speed-up">speed-up</button>
    <button data-testid="reject-nudge">reject-nudge</button>
    <button data-testid="pause">pause</button>
    <button data-testid="malformed-pause">malformed-pause</button>
    <button data-testid="cancel">cancel</button>
    <button data-testid="start-held">start held stream</button>
    <button data-testid="cancel-held">cancel held stream</button>
    <button data-testid="start-break">start-break</button>
    <span data-testid="status"></span>
    <span data-testid="stream-id"></span>
    <span data-testid="tokens"></span>
    <span data-testid="active"></span>
    <span data-testid="stream-end"></span>
    <span data-testid="nudge-ok"></span>
    <span data-testid="nudge-error"></span>
    <span data-testid="break-end"></span>
    <span data-testid="held-stream-id"></span>
    <span data-testid="held-end"></span>
    <span data-testid="held-server-released"></span>
  `);

  const socket = client<StreamNudgesClient>()(connect(wsUrl('stream-nudges')), stream());

  type Handle = Awaited<ReturnType<typeof socket.stream<'start-nudge-stream'>>>;
  let handle: Handle | null = null;
  let heldHandle: Handle | null = null;

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });
  socket.on('held-stream-released', () => {
    el('held-server-released').textContent = 'yes';
  });

  button('connect', () => socket.connect());

  button('start', async () => {
    const started = await socket.stream('start-nudge-stream', {
      prompt: 'one two three four five six seven eight nine ten',
    });
    handle = started;
    el('stream-id').textContent = started.streamId;
    el('active').textContent = String(started.active);
    void (async () => {
      for await (const chunk of started) {
        el('tokens').textContent = (el('tokens').textContent ?? '') + chunk.token;
      }

      el('active').textContent = String(started.active);
      el('stream-end').textContent = 'yes';
    })();
  });

  button('speed-up', async () => {
    if (!handle) return;

    try {
      await handle.nudge('speed-up', { factor: 4 });
      el('nudge-ok').textContent = 'yes';
    } catch (err) {
      el('nudge-error').textContent = errorCode(err);
    }
  });

  // factor 0 makes the server's nudge intercept throw a typed error. The
  // nudge() Promise must reject with that code while the stream keeps running.
  button('reject-nudge', async () => {
    if (!handle) return;

    try {
      await handle.nudge('speed-up', { factor: 0 });
      el('nudge-ok').textContent = 'yes';
    } catch (err) {
      el('nudge-error').textContent = errorCode(err);
    }
  });

  button('pause', async () => {
    if (!handle) return;

    await handle.nudge('pause', {});
    el('nudge-ok').textContent = 'yes';
  });

  button('malformed-pause', async () => {
    if (!handle) return;

    try {
      await handle.nudge('pause', { leak: 'extra' });
      el('nudge-ok').textContent = 'yes';
    } catch (err) {
      el('nudge-error').textContent = errorCode(err);
    }
  });

  button('cancel', () => {
    handle?.cancel();
  });

  button('start-held', async () => {
    const started = await socket.stream('start-nudge-stream', { prompt: '__hold-overflow__' });
    heldHandle = started;
    el('held-stream-id').textContent = started.streamId;
    void (async () => {
      for await (const _chunk of started) {
        void _chunk;
      }

      el('held-end').textContent = 'yes';
    })();
  });

  button('cancel-held', () => {
    heldHandle?.cancel();
  });

  button('start-break', async () => {
    const breakHandle = await socket.stream('start-nudge-stream', {
      prompt: 'one two three four five six seven eight nine ten',
    });
    for await (const _chunk of breakHandle) {
      break;
    }

    el('break-end').textContent = String(breakHandle.active);
  });

  ready();
}

setup();
