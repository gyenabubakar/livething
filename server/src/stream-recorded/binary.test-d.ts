/* oxlint-disable no-unused-vars */
/**
 * Compile-time checks for `binary.recordedStream`: which capabilities it needs, the info
 * types, and what `InferClient` carries for it.
 */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { InferClient } from '~/infer-client.ts';

const base = server({ capabilities: [binary(), channels(), recordedStream()] });
const rooms = base.channel(['rooms', 'room:{roomId}'], {});

const handleDownloadAttachment = base.binary.recordedStream('download-attachment', {
  input: v.object({ attachmentId: v.string() }),
  chunk: t<{ fileName: string } | null>(),
  maxChunks: 2000,
  maxBufferBytes: 128 * 1024 * 1024,
  maxBytes: 1024,
  async *run(_ctx, input, bytes) {
    expectTypeOf(input).toEqualTypeOf<{ attachmentId: string }>();
    expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
    yield { info: { fileName: 'launch-plan.pdf' }, bytes: new Uint8Array(4) };
    yield { info: null, bytes: new Uint8Array(4) };
  },
});

const handleDownloadRecording = rooms.binary.recordedStream('download-recording', {
  input: v.object({ recordingId: v.string() }),
  async *run(ctx) {
    yield { info: { room: ctx.channel.name }, bytes: new Uint8Array(4) };
  },
});

const definition = base.assemble({
  handlers: [rooms, handleDownloadAttachment, handleDownloadRecording],
});
type Client = InferClient<typeof definition>;

expectTypeOf<Client['binary']['streams']>().toEqualTypeOf<{
  'download-attachment': {
    payload: { attachmentId: string };
    chunk: { fileName: string } | null;
    kind: 'persistent';
  };
}>();
expectTypeOf<Client['channels']['rooms']['binary']['streams']>().toEqualTypeOf<{
  'download-recording': {
    payload: { recordingId: string };
    chunk: { room: string };
    kind: 'persistent';
  };
}>();

const noRecorded = server({ capabilities: [binary(), channels()] });
// @ts-expect-error: base.binary.recordedStream needs recordedStream()
noRecorded.binary.recordedStream('download-attachment', { async *run() {} });
const lobby = noRecorded.channel('lobby', {});
// @ts-expect-error: a channel's binary.recordedStream needs recordedStream()
lobby.binary.recordedStream('download-recording', { async *run() {} });
