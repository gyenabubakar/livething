import {
  binary,
  buffering,
  channels,
  client,
  clientRequests,
  connect,
  dedup,
  reconnection,
  replay,
  serverRequests,
  stream,
} from '@livething/client';
import type { BinaryClient } from '@livething/tests-e2e-handlers/binary';
import {
  button,
  el,
  errorCode,
  mount,
  OFFLINE_WINDOW_MAX_DELAY,
  ready,
  wsUrl,
} from '../_shared.ts';
import { hash, pattern } from './bytes.ts';

// Drives @livething/client's binary() against the real `binary` server definition: an
// avatar upload that gets a preview back, screen frames shared in a room, a binary request,
// a binary download stream, a binary request from the server, and the screen frames a member
// gets back from replay after it reconnects. The page shows a hash of
// the whole bytes, so the spec checks every byte.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="upload-avatar">upload-avatar</button>
    <button data-testid="join-room">join-room</button>
    <button data-testid="share-frames">share-frames</button>
    <button data-testid="get-thumbnail">get-thumbnail</button>
    <button data-testid="download-attachment">download-attachment</button>
    <button data-testid="cancel-download">cancel-download</button>
    <button data-testid="start-screen-share">start-screen-share</button>
    <button data-testid="drop">drop</button>
    <span data-testid="status"></span>
    <span data-testid="reconnects"></span>
    <span data-testid="preview"></span>
    <span data-testid="joined"></span>
    <span data-testid="shared"></span>
    <span data-testid="frames"></span>
    <span data-testid="thumbnail"></span>
    <span data-testid="download"></span>
    <span data-testid="cancelled"></span>
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
    clientRequests(),
    dedup(),
    reconnection({ maxDelay: OFFLINE_WINDOW_MAX_DELAY }),
    replay(),
    serverRequests(),
    stream(),
  );
  const room = socket.channel('rooms', roomName);

  const errors: string[] = [];

  const frames: string[] = [];

  function report(error: unknown): void {
    errors.push(errorCode(error) || String(error));
    el('errors').textContent = errors.join('|');
  }

  socket.onError(report);
  socket.onServerError(report);
  // A request or a stream that fails shows its error on the page.
  function recorded(run: () => Promise<void>): () => Promise<void> {
    return () => run().catch(report);
  }

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

  // The server asks this client for one full picture of its screen.
  socket.binary.onRequest('capture-screen', (info) => ({
    info: { fileType: 'image/png' },
    bytes: pattern(info.maxWidth * 40, seed + 100),
  }));

  const attachmentId = page.get('attachment') ?? 'att_300';

  button(
    'get-thumbnail',
    recorded(async () => {
      const { info, bytes } = await socket.binary.request('get-thumbnail', { attachmentId });
      el('thumbnail').textContent = `${info.fileType} ${bytes.byteLength} ${hash(bytes)}`;
    }),
  );

  button(
    'download-attachment',
    recorded(async () => {
      const download = await socket.binary.stream('download-attachment', {
        attachmentId,
        fromByte: 0,
      });
      const pieces: Uint8Array[] = [];
      let fileName = '';
      for await (const { info, bytes } of download) {
        if (info) fileName = info.fileName;
        pieces.push(bytes.slice());
      }

      const file = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
      let offset = 0;
      for (const piece of pieces) {
        file.set(piece, offset);
        offset += piece.byteLength;
      }

      el('download').textContent = `${fileName} ${pieces.length} ${file.byteLength} ${hash(file)}`;
    }),
  );

  button(
    'cancel-download',
    recorded(async () => {
      const download = await socket.binary.stream('download-attachment', {
        attachmentId: 'att_0',
        fromByte: 0,
      });
      for await (const _piece of download) break;

      // The server sees the cancel a little later than the client sends it.
      for (let tries = 0; tries < 50; tries++) {
        const { cancelled } = await socket.request('was-download-cancelled', null);
        if (cancelled) {
          el('cancelled').textContent = `yes ${download.active}`;
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      el('cancelled').textContent = 'no';
    }),
  );

  button('start-screen-share', () => {
    room.send('start-screen-share', {});
  });

  // The server closes this connection, and the client reconnects and asks for what it missed.
  button('drop', () => {
    socket.send('server-drop', {});
  });

  let reconnects = 0;
  socket.onReconnect(() => {
    reconnects += 1;
    el('reconnects').textContent = String(reconnects);
  });
  el('reconnects').textContent = '0';

  ready();
}

setup();
