import { client, connect, serialization } from '@wskit/client';
import type { BinaryClient } from '@wskit/tests-e2e-handlers/binary';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's serialization() against the real `binary` handler.
// The handler's onBinary echoes the raw bytes back via ctx.sendBinary and also
// pushes a JSON `binary-meta`. parseBinary decodes the echoed bytes into a
// `binary-meta` frame so the round-trip lands in socket.on(), tagged with a
// constant username so the spec can tell the decoded echo apart from the JSON
// event the server sends (which carries the page's real username).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="send-binary">send-binary</button>
    <button data-testid="send-self">send-self</button>
    <span data-testid="status"></span>
    <span data-testid="echo-size"></span>
    <span data-testid="echo-username"></span>
    <span data-testid="meta-size"></span>
    <span data-testid="meta-username"></span>
  `);

  const socket = client<BinaryClient>()(
    connect(wsUrl('binary')),
    serialization({
      binaryType: 'arraybuffer',
      parseBinary: (data) => ({
        event: 'binary-meta',
        payload: { size: data.byteLength, username: 'echoed-binary' },
      }),
    }),
  );

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  socket.on('binary-meta', ({ size, username }) => {
    if (username === 'echoed-binary') {
      el('echo-size').textContent = String(size);
      el('echo-username').textContent = username;
    } else {
      el('meta-size').textContent = String(size);
      el('meta-username').textContent = username;
    }
  });

  button('connect', () => socket.connect());

  button('send-binary', () => {
    socket.sendBinary(new Uint8Array([1, 2, 3, 4, 5]).buffer);
  });

  button('send-self', () => {
    socket.send('send-self-binary', { size: 7 });
  });

  ready();
}

setup();
