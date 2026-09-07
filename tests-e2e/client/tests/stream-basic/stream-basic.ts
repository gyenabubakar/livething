import { client, connect, stream } from '@wskit/client';
import type { StreamBasicClient } from '@wskit/tests-e2e-handlers/stream-basic';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's stream() against the real `stream-basic` handler, typed
// by the same contract the server implements (StreamBasicClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-tokens">start-tokens</button>
    <button data-testid="start-boom">start-boom</button>
    <button data-testid="start-typed-error">start-typed-error</button>
    <button data-testid="start-empty">start-empty</button>
    <button data-testid="start-break">start-break</button>
    <button data-testid="start-observe">start-observe</button>
    <button data-testid="start-two">start-two</button>
    <span data-testid="status"></span>
    <span data-testid="stream-ok"></span>
    <span data-testid="stream-id"></span>
    <span data-testid="chunk-indices"></span>
    <span data-testid="stream-end"></span>
    <span data-testid="stream-error"></span>
    <span data-testid="break-count"></span>
    <span data-testid="cancel-observed"></span>
    <span data-testid="stream-id-1"></span>
    <span data-testid="stream-id-2"></span>
    <span data-testid="ids-distinct"></span>
  `);

  const socket = client<StreamBasicClient>()(connect(wsUrl('stream-basic')), stream());

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('cancel-observed', (data) => {
    el('cancel-observed').textContent = data.cancelled ? 'yes' : 'no';
  });

  button('connect', () => socket.connect());

  button('start-tokens', async () => {
    el('chunk-indices').textContent = '';
    el('stream-end').textContent = 'no';
    const handle = await socket.stream('start-tokens', { count: 3 });
    el('stream-ok').textContent = 'yes';
    el('stream-id').textContent = handle.streamId;

    const indices: number[] = [];
    for await (const chunk of handle) {
      indices.push(chunk.index);
      el('chunk-indices').textContent = indices.join(',');
    }

    el('stream-end').textContent = 'yes';
  });

  button('start-boom', async () => {
    const handle = await socket.stream('start-boom', {});
    try {
      for await (const chunk of handle) {
        void chunk;
      }
    } catch (err) {
      el('stream-error').textContent = errorCode(err);
    }
  });

  button('start-typed-error', async () => {
    const handle = await socket.stream('start-typed-error', {});
    try {
      for await (const chunk of handle) {
        void chunk;
      }
    } catch (err) {
      el('stream-error').textContent = errorCode(err);
    }
  });

  button('start-empty', async () => {
    el('chunk-indices').textContent = '';
    el('stream-end').textContent = 'no';
    const handle = await socket.stream('start-empty', {});
    el('stream-ok').textContent = 'yes';
    const indices: number[] = [];

    for await (const chunk of handle) {
      indices.push(chunk.index);
    }

    el('chunk-indices').textContent = indices.join(',');
    el('stream-end').textContent = 'yes';
  });

  // Breaking the loop cancels the stream: read one chunk, break, then prove the
  // iterator stopped (fewer than the 20 the generator would emit).
  button('start-break', async () => {
    const handle = await socket.stream('start-cancel-observe', {});
    let count = 0;
    for await (const chunk of handle) {
      void chunk;
      count += 1;
      break;
    }

    el('break-count').textContent = String(count);
  });

  // Cancel mid-stream so the generator's finally block fires cancel-observed.
  button('start-observe', async () => {
    const handle = await socket.stream('start-cancel-observe', {});
    for await (const chunk of handle) {
      void chunk;
      handle.cancel();
    }
  });

  // Two streams in turn must carry distinct ids (start-tokens defaults to
  // allowConcurrent:false, so each must finish before the next begins).
  button('start-two', async () => {
    const one = await socket.stream('start-tokens', { count: 1 });
    el('stream-id-1').textContent = one.streamId;
    for await (const chunk of one) void chunk;
    const two = await socket.stream('start-tokens', { count: 1 });
    el('stream-id-2').textContent = two.streamId;

    for await (const chunk of two) void chunk;
    el('ids-distinct').textContent = one.streamId !== two.streamId ? 'yes' : 'no';
  });

  ready();
}

setup();
