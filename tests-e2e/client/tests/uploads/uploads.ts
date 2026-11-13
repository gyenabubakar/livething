import {
  binary,
  client,
  clientRequests,
  connect,
  plugin,
  reconnection,
  uploads,
} from '@livething/client';
import type { Upload } from '@livething/client';
import type { FilesWire, UploadsClient } from '@livething/tests-e2e-handlers/uploads';
import {
  button,
  el,
  errorCode,
  mount,
  OFFLINE_WINDOW_MAX_DELAY,
  ready,
  wsUrl,
} from '../_shared.ts';
import { pattern } from '../binary/bytes.ts';

// Drives @livething/client's uploads() against the real `uploads` server definition: a Blob,
// bytes and an AsyncIterable, a slow upload that resumes after a drop or a page reload, a
// cancel, a failing `run`, a file over the limit, and four photos with one caption. The page
// shows each reply's info, which carries the server's hash of the stored bytes.
export const KiB = 1024;

/** The photos of the `upload-photos` scenario: their ids, sizes and seeds. */
export const PHOTOS = [
  { photoId: 'photo_1', size: 70_000, seed: 11 },
  { photoId: 'photo_2', size: 30_000, seed: 12 },
  { photoId: 'photo_3', size: 120_000, seed: 13 },
  { photoId: 'photo_4', size: 5_000, seed: 14 },
];

/** The uneven chunks of the AsyncIterable scenarios. */
export const CHUNKS = [50_000, 100_001, 49_999];

/** The scoped socket the `acme:files` plugin gets. */
type FilesSocket = Parameters<Parameters<ReturnType<typeof plugin<FilesWire>>>[0]['setup']>[0];

export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="upload-blob">upload-blob</button>
    <button data-testid="upload-bytes">upload-bytes</button>
    <button data-testid="upload-iterable">upload-iterable</button>
    <button data-testid="upload-slow">upload-slow</button>
    <button data-testid="upload-slow-smaller">upload-slow-smaller</button>
    <button data-testid="upload-iterable-slow">upload-iterable-slow</button>
    <button data-testid="upload-failing">upload-failing</button>
    <button data-testid="upload-too-large">upload-too-large</button>
    <button data-testid="upload-photos">upload-photos</button>
    <button data-testid="upload-plugin">upload-plugin</button>
    <button data-testid="upload-plugin-full">upload-plugin-full</button>
    <button data-testid="lazy">lazy</button>
    <button data-testid="cancel">cancel</button>
    <button data-testid="drop">drop</button>
    <button data-testid="check-attachment">check-attachment</button>
    <span data-testid="status"></span>
    <span data-testid="upload-id"></span>
    <span data-testid="progress"></span>
    <span data-testid="attempts"></span>
    <span data-testid="reply"></span>
    <span data-testid="attachment"></span>
    <span data-testid="lazy-sent"></span>
    <span data-testid="errors"></span>
  `);

  const page = new URLSearchParams(location.search);
  const seed = Number(page.get('seed') ?? '1');
  const uploadId = page.get('uploadId') ?? undefined;
  // The client half of the `acme:files` plugin: its scoped socket uploads under its own names.
  let files!: FilesSocket;
  const Files = plugin<FilesWire>()({
    id: 'acme:files',
    dependencies: [binary, uploads],
    setup(scoped) {
      files = scoped;
      return {};
    },
  });
  const socket = client<UploadsClient>()(
    connect(wsUrl('uploads', { holdRoom: true })),
    binary(),
    uploads(),
    clientRequests(),
    reconnection({ maxDelay: OFFLINE_WINDOW_MAX_DELAY }),
    Files(),
  );

  const errors: string[] = [];
  function report(error: unknown): void {
    const code = errorCode(error);
    const reason = (error as { detail?: { reason?: string } }).detail?.reason;
    errors.push(reason ? `${code}:${reason}` : code || String(error));
    el('errors').textContent = errors.join('|');
  }

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  function whenOpen(): Promise<void> {
    return new Promise((resolve) => {
      if (socket.state.get() === 'open') {
        resolve();
        return;
      }

      const stop = socket.state.subscribe(() => {
        if (socket.state.get() !== 'open') return;

        stop();
        resolve();
      });
    });
  }

  let current: Upload<unknown> | undefined;
  let attempts = 0;
  el('attempts').textContent = '0';

  /** Start the upload, and start it again after each drop, as an app does. */
  async function run(upload: Upload<unknown>): Promise<void> {
    current = upload;
    el('upload-id').textContent = upload.id;
    upload.onProgress((bytes) => {
      el('progress').textContent = String(bytes);
    });
    for (;;) {
      try {
        const { info } = await upload.start();
        el('reply').textContent = JSON.stringify(info);
        return;
      } catch (error) {
        if (errorCode(error) !== 'disconnected') {
          report(error);
          return;
        }

        attempts += 1;
        el('attempts').textContent = String(attempts);
        await whenOpen();
      }
    }
  }

  async function* chunks(slowMs = 0): AsyncIterable<Uint8Array> {
    const file = pattern(
      CHUNKS.reduce((total, size) => total + size, 0),
      seed,
    );
    let at = 0;
    for (const size of CHUNKS) {
      yield file.subarray(at, at + size);
      at += size;
      if (slowMs) await new Promise((resolve) => setTimeout(resolve, slowMs));
    }
  }

  button('connect', () => socket.connect());
  button('upload-blob', () =>
    run(
      socket.binary.upload('upload-attachment', new Blob([pattern(300_000, seed)]), {
        input: { attachmentId: 'att_blob' },
      }),
    ),
  );
  button('upload-bytes', () =>
    run(
      socket.binary.upload('upload-attachment', pattern(200_000, seed), {
        input: { attachmentId: 'att_bytes' },
      }),
    ),
  );
  button('upload-iterable', () =>
    run(
      socket.binary.upload('upload-attachment', chunks(), { input: { attachmentId: 'att_iter' } }),
    ),
  );
  // 512 KiB at 300 ms a piece, saved every two pieces: slow enough to drop in the middle.
  button('upload-slow', () =>
    run(
      socket.binary.upload('upload-attachment', new Blob([pattern(512 * KiB, seed)]), {
        input: { attachmentId: 'att_slow', saveEvery: 2, slowMs: 300 },
        uploadId,
      }),
    ),
  );
  // The same input as upload-slow, but a smaller file: a resume with it is refused.
  button('upload-slow-smaller', () =>
    run(
      socket.binary.upload('upload-attachment', new Blob([pattern(256 * KiB, seed)]), {
        input: { attachmentId: 'att_slow', saveEvery: 2, slowMs: 300 },
        uploadId,
      }),
    ),
  );
  button('upload-iterable-slow', () =>
    run(
      socket.binary.upload('upload-attachment', chunks(300), {
        input: { attachmentId: 'att_iter_slow', slowMs: 1000 },
      }),
    ),
  );
  button('upload-failing', () =>
    run(
      socket.binary.upload('upload-attachment', new Blob([pattern(300_000, seed)]), {
        input: { attachmentId: 'att_fail', failAt: 2 },
      }),
    ),
  );
  button('upload-too-large', () =>
    run(
      socket.binary.upload('upload-attachment', new Blob([new Uint8Array(4 * 1024 * KiB + 1)]), {
        input: { attachmentId: 'att_huge' },
      }),
    ),
  );
  // Four photos, one caption: joined into one Blob, with each photo's size in the input.
  button('upload-photos', () =>
    run(
      socket.binary.upload(
        'upload-photos',
        new Blob(PHOTOS.map(({ size, seed: photoSeed }) => pattern(size, photoSeed))),
        {
          input: {
            caption: 'Just an example',
            photos: PHOTOS.map(({ photoId, size }) => ({ photoId, size })),
          },
        },
      ),
    ),
  );
  // The plugin's upload, through its scoped socket.
  button('upload-plugin', () =>
    run(
      files.binary.upload('store-file', new Blob([pattern(150_000, seed)]), {
        input: { fileId: 'f1' },
      }),
    ),
  );
  button('upload-plugin-full', () =>
    run(
      files.binary.upload('store-file', new Blob([pattern(150_000, seed)]), {
        input: { fileId: 'f2', full: true },
      }),
    ),
  );
  // An upload that is made but never started sends nothing.
  button('lazy', async () => {
    socket.binary.upload('upload-attachment', pattern(10, seed), {
      input: { attachmentId: 'att_lazy' },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { size } = await socket.request('get-attachment', { attachmentId: 'att_lazy' });
    el('lazy-sent').textContent = String(size);
  });
  button('cancel', () => current?.cancel());
  button('drop', () => {
    socket.send('server-drop', {});
  });
  button('check-attachment', async () => {
    const attachmentId = page.get('attachment') ?? 'att_slow';
    const stored = await socket.request('get-attachment', { attachmentId });
    const { discarded } = await socket.request('list-discarded', {});
    el('attachment').textContent = JSON.stringify({ ...stored, discarded: discarded.length });
  });

  ready();
}

setup();
