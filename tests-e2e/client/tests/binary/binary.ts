import { binary, buffering, channels, client, connect, dedup } from '@livething/client';
import type { BinaryClient } from '@livething/tests-e2e-handlers/binary';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';
import { hash, pattern } from './bytes.ts';

// Drives @livething/client's binary() against the real `binary` server definition: an
// avatar upload that gets a preview back, and screen frames shared in a room. The page
// shows a hash of the whole bytes, so the spec checks every byte.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="upload-avatar">upload-avatar</button>
    <button data-testid="join-room">join-room</button>
    <button data-testid="share-frames">share-frames</button>
    <span data-testid="status"></span>
    <span data-testid="preview"></span>
    <span data-testid="joined"></span>
    <span data-testid="shared"></span>
    <span data-testid="frames"></span>
    <span data-testid="errors"></span>
  `);

  const page = new URLSearchParams(location.search);
  const seed = Number(page.get('seed') ?? '1');
  const roomName = page.get('channel') ?? 'room:general';
  const socket = client<BinaryClient>()(
    connect(wsUrl('binary')),
    binary(),
    buffering({ maxBytes: 4 * 1024 * 1024 }),
    channels(),
    dedup(),
  );
  const room = socket.channel('rooms', roomName);

  const errors: string[] = [];

  const frames: string[] = [];

  socket.onError((error) => {
    errors.push(String(error));
    el('errors').textContent = errors.join('|');
  });
  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.binary.on('avatar-preview', (info, bytes) => {
    el('preview').textContent = `${info.fileType} ${info.size} ${bytes.byteLength} ${hash(bytes)}`;
  });

  room.binary.on('screen-frame', (info, bytes) => {
    frames.push(`${info.from}:${bytes.byteLength}:${hash(bytes)}`);
    el('frames').textContent = frames.join('|');
  });

  button('connect', () => socket.connect());

  button('upload-avatar', () => {
    socket.binary.send('upload-avatar', { fileType: 'image/png' }, pattern(300_000, seed));
  });

  button('join-room', async () => {
    await room.subscribe();
    el('joined').textContent = 'yes';
  });

  button('share-frames', async () => {
    for (let i = 0; i < 3; i++) {
      room.binary.send('share-screen-frame', null, pattern(100_000 + i, seed + i));
      await socket.drain();
    }

    el('shared').textContent = 'yes';
  });

  ready();
}

setup();
