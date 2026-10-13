/* oxlint-disable no-unused-vars */
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { cursorStream, recordedStream, stream } from '~/streams.ts';

const base = server({
  capabilities: [channels(), clientRequests(), stream(), cursorStream(), recordedStream()],
});

base.on('ordered', {
  allowInterleaving: true,
  run() {},
});

base.request('interleaved', {
  allowInterleaving: false,
  run() {
    return { ok: true };
  },
});

const room = base.channel('room');

room.on('ordered', {
  allowInterleaving: true,
  run() {},
});

room.request('interleaved', {
  allowInterleaving: false,
  run() {
    return { ok: true };
  },
});

// `allowConcurrent` controls overlapping instances of one stream event. The
// normal per-connection handler scheduler does not apply to streams.
base.stream('plain', {
  allowConcurrent: true,
  async *run() {
    yield { ok: true };
  },
});

base.cursorStream('cursor', {
  allowConcurrent: true,
  async *run() {
    yield { ok: true };
  },
});

base.recordedStream('recorded', {
  allowConcurrent: true,
  async *run() {
    yield { ok: true };
  },
});

base.stream('no-interleaving', {
  // @ts-expect-error — streams use allowConcurrent, not allowInterleaving.
  allowInterleaving: true,
  async *run() {
    yield { ok: true };
  },
});
