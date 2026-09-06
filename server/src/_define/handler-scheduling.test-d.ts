/* oxlint-disable no-unused-vars */
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { recordedStream, resumableStream, stream } from '~/streams.ts';

const base = define({
  capabilities: [channels(), clientRequests(), stream(), resumableStream(), recordedStream()],
});

base.on('ordered', {
  allowInterleaving: true,
  run() {},
});

base.request('interleaved', {
  allowInterleaving: false,
  run() {
    return true;
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
    return true;
  },
});

// `allowConcurrent` controls overlapping instances of one stream event. The
// normal per-connection handler scheduler does not apply to streams.
base.stream('plain', {
  allowConcurrent: true,
  async *run() {
    yield true;
  },
});

base.resumableStream('resumable', {
  allowConcurrent: true,
  async *run() {
    yield true;
  },
});

base.recordedStream('recorded', {
  allowConcurrent: true,
  async *run() {
    yield true;
  },
});

base.stream('no-interleaving', {
  // @ts-expect-error — streams use allowConcurrent, not allowInterleaving.
  allowInterleaving: true,
  async *run() {
    yield true;
  },
});
