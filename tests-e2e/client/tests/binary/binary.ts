import {
  binary,
  buffering,
  channels,
  client,
  clientRequests,
  connect,
  dedup,
  inbox,
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
// a binary download stream, a binary request from the server, the screen frames a member
// gets back from replay after it reconnects, voice notes in a DM's inbox, and a recorded
// binary export that a client continues. The page shows a hash of the whole bytes, so the
// spec checks every byte.
/** The size and the hash of the pieces put together. */
function joined(pieces: Uint8Array[]): string {
  const file = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    file.set(piece, offset);
    offset += piece.byteLength;
  }

  return `${file.byteLength} ${hash(file)}`;
}

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
    <button data-testid="disconnect">disconnect</button>
    <button data-testid="join-dm">join-dm</button>
    <button data-testid="send-voice-note">send-voice-note</button>
    <button data-testid="start-export">start-export</button>
    <button data-testid="continue-export">continue-export</button>
    <span data-testid="status"></span>
    <span data-testid="dm-joined"></span>
    <span data-testid="voice-notes"></span>
    <span data-testid="export-pieces"></span>
    <span data-testid="export"></span>
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
    inbox(),
    reconnection({ maxDelay: OFFLINE_WINDOW_MAX_DELAY }),
    replay(),
    serverRequests(),
    stream(),
  );
  const room = socket.channel('rooms', roomName);

  const dm = socket.channel('dms', 'dm:amara-kofi');

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

      el('download').textContent = `${fileName} ${pieces.length} ${joined(pieces)}`;
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

  const voiceNotes: string[] = [];
  dm.binary.on('voice-note', (info, bytes) => {
    voiceNotes.push(`${info.from}:${info.durationMs}:${bytes.byteLength}:${hash(bytes)}`);
    el('voice-notes').textContent = voiceNotes.join('|');
  });

  button('join-dm', async () => {
    await dm.subscribe();
    el('dm-joined').textContent = 'yes';
  });

  button('send-voice-note', () => {
    dm.binary.send('send-voice-note', { durationMs: 4200 }, pattern(300_000, seed + 200));
  });

  // The PDF export of room:300, a recorded binary stream. The page shows how many pieces it
  // has read, then the whole file.
  const exportId = page.get('export') ?? 'export-1';
  async function readExport(
    pdf: AsyncIterable<{ info: { fileName: string } | null; bytes: Uint8Array }>,
  ) {
    const pieces: Uint8Array[] = [];
    let fileName = '';
    for await (const { info, bytes } of pdf) {
      if (info) fileName = info.fileName;
      pieces.push(bytes.slice());
      el('export-pieces').textContent = String(pieces.length);
    }

    el('export').textContent = `${fileName} ${pieces.length} ${joined(pieces)}`;
  }

  button(
    'start-export',
    recorded(async () => {
      const pdf = await socket.binary.stream('export-room-pdf', { roomId: 'room:300' }, undefined, {
        streamId: exportId,
      });
      await readExport(pdf);
    }),
  );

  // Another page continues the export this one started, as after a page reload.
  button(
    'continue-export',
    recorded(() => readExport(socket.binary.continueStream('export-room-pdf', exportId))),
  );

  button('disconnect', () => socket.disconnect());

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
