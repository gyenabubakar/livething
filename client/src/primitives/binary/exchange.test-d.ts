/* oxlint-disable no-unused-vars */
// Compile-time checks for binary requests, server requests and streams on the client
// (binary spec 7.4, 7.5, 11.4). tsc checks these; vitest never runs them. The contract is
// shaped like `InferClient` output for Huddle.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { binary } from '~/primitives/binary/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { expectTypeOf } from 'vitest';
import type { BinaryItem, BinaryMessaging } from '~/primitives/binary/types.ts';
import type { StreamHandle } from '~/types.ts';

type Attachment = { fileName: string; fileType: string } | null;

interface HuddleSocket {
  binary: {
    incoming: { 'avatar-preview': null };
    outgoing: {};
    clientRequests: {
      'get-thumbnail': { payload: { attachmentId: string }; response: { fileType: 'image/png' } };
    };
    serverRequests: {
      'capture-screen': { payload: { maxWidth: number }; response: { fileType: 'image/png' } };
    };
    streams: {
      'download-attachment': {
        payload: { attachmentId: string; fromByte: number };
        chunk: Attachment;
        kind: 'ephemeral';
      };
    };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: {};
      outgoing: {};
      binary: {
        incoming: { 'screen-frame': { from: string } };
        outgoing: {};
        clientRequests: {
          'get-whiteboard': { payload: null; response: { fileType: 'image/png' } };
        };
        serverRequests: {};
        streams: { 'download-recording': { payload: null; chunk: null; kind: 'ephemeral' } };
      };
    };
  };
}

const url = 'wss://huddle.example.com/huddle';
const socket = client<HuddleSocket>()(
  connect(url),
  binary(),
  channels(),
  clientRequests(),
  serverRequests(),
  stream(),
);
const picture = new Uint8Array([137, 80, 78, 71]);

// binary.request: the info, optional bytes, optional options; resolves { info, bytes }.
expectTypeOf(socket.binary.request('get-thumbnail', { attachmentId: 'att_1' })).toEqualTypeOf<
  Promise<BinaryItem<{ fileType: 'image/png' }>>
>();
socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, picture);
socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, picture.buffer as ArrayBuffer);
socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, undefined, { timeout: 5_000 });
// @ts-expect-error: wrong info type
socket.binary.request('get-thumbnail', { attachmentId: 1 });
// @ts-expect-error: the bytes must be a Uint8Array or an ArrayBuffer
socket.binary.request('get-thumbnail', { attachmentId: 'att_1' }, 'bytes');
// @ts-expect-error: a binary server request is not a client request
socket.binary.request('capture-screen', { maxWidth: 1280 });
// @ts-expect-error: a binary request is not a JSON request
socket.request('get-thumbnail', { attachmentId: 'att_1' });

// binary.onRequest: the handler gets (info, bytes), returns { info, bytes? }, maybe async.
socket.binary.onRequest('capture-screen', async (info, bytes) => {
  expectTypeOf(info).toEqualTypeOf<{ maxWidth: number }>();
  expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
  return { info: { fileType: 'image/png' }, bytes: picture };
});
expectTypeOf(
  socket.binary.onRequest('capture-screen', () => ({ info: { fileType: 'image/png' } })),
).toEqualTypeOf<() => void>();
// @ts-expect-error: the answer's info has the wrong type
socket.binary.onRequest('capture-screen', () => ({ info: { fileType: 'image/gif' } }));
// @ts-expect-error: the answer must be { info, bytes }, not the info alone
socket.binary.onRequest('capture-screen', () => ({ fileType: 'image/png' }));

// binary.stream: each item is { info, bytes }; the handle is a JSON stream's handle.
async function download(): Promise<void> {
  const handle = await socket.binary.stream('download-attachment', {
    attachmentId: 'att_1',
    fromByte: 0,
  });
  expectTypeOf(handle).toEqualTypeOf<StreamHandle<BinaryItem<Attachment>, {}>>();
  for await (const { info, bytes } of handle) {
    expectTypeOf(info).toEqualTypeOf<Attachment>();
    expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
  }
}

socket.binary.stream('download-attachment', { attachmentId: 'att_1', fromByte: 0 }, undefined, {
  streamId: 'download-1',
});
// @ts-expect-error: wrong info type
socket.binary.stream('download-attachment', { attachmentId: 'att_1' });
socket.binary.onStream('download-attachment', {
  onChunk(chunk, streamId) {
    expectTypeOf(chunk).toEqualTypeOf<BinaryItem<Attachment>>();
    expectTypeOf(streamId).toEqualTypeOf<string>();
  },
});
// @ts-expect-error: a binary stream is not a JSON stream
socket.stream('download-attachment', { attachmentId: 'att_1', fromByte: 0 });

// Channel handles: the channel's own binary requests and streams, and events.
const general = socket.channel('rooms', 'room:general');
expectTypeOf(general.binary.request('get-whiteboard', null)).toEqualTypeOf<
  Promise<BinaryItem<{ fileType: 'image/png' }>>
>();
general.binary.on('screen-frame', () => {});
general.binary.stream('download-recording', null);
general.binary.onStream('download-recording', { onChunk: () => {} });
// @ts-expect-error: the channel has no binary server requests
general.binary.onRequest;
// @ts-expect-error: 'get-thumbnail' belongs to the top level
general.binary.request('get-thumbnail', { attachmentId: 'att_1' });

// Each method needs its primitive. Without it, the method is a stub that names it.
const eventsOnly = client<HuddleSocket>()(connect(url), binary(), channels());
eventsOnly.binary.on('avatar-preview', () => {});
expectTypeOf(eventsOnly.binary.request).toEqualTypeOf<{
  error: '[livething] binary.request needs the clientRequests() primitive — add clientRequests() to client()';
}>();
expectTypeOf(eventsOnly.binary.onRequest).toEqualTypeOf<{
  error: '[livething] binary.onRequest needs the serverRequests() primitive — add serverRequests() to client()';
}>();
expectTypeOf(eventsOnly.binary.stream).toEqualTypeOf<{
  error: '[livething] binary.stream needs the stream() primitive — add stream() to client()';
}>();
expectTypeOf(eventsOnly.binary.onStream).toEqualTypeOf<{
  error: '[livething] binary.onStream needs the stream() primitive — add stream() to client()';
}>();
// @ts-expect-error: binary.request needs clientRequests()
eventsOnly.binary.request('get-thumbnail', { attachmentId: 'att_1' });
// @ts-expect-error: a channel's binary.request needs clientRequests() too
eventsOnly.channel('rooms', 'room:general').binary.request('get-whiteboard', null);
// @ts-expect-error: a channel's binary.stream needs stream() too
eventsOnly.channel('rooms', 'room:general').binary.stream('download-recording', null);
// A scope with no binary requests gets no stub.
// @ts-expect-error: the rooms channel has no binary server requests
eventsOnly.channel('rooms', 'room:general').binary.onRequest;

// A binary server request with no `in` schema answers with `null` (or `undefined`) info.
interface CameraSocket {
  binary: { serverRequests: { 'capture-camera': { payload: null; response: void } } };
}

const camera = client<CameraSocket>()(connect(url), binary(), serverRequests());
camera.binary.onRequest('capture-camera', () => ({ info: null, bytes: picture }));
camera.binary.onRequest('capture-camera', async () => ({ info: null, bytes: picture }));
camera.binary.onRequest('capture-camera', () => ({ info: undefined }));
// @ts-expect-error: no info is expected, so a value is wrong
camera.binary.onRequest('capture-camera', () => ({ info: { fileType: 'image/png' } }));
// @ts-expect-error: the answer always has an `info` key, so the client can tell it from bytes alone
camera.binary.onRequest('capture-camera', () => ({ bytes: picture }));

// A scope with only requests or streams still gets `.binary`.
interface RequestsOnly {
  binary: {
    clientRequests: {
      'get-thumbnail': { payload: { attachmentId: string }; response: { fileType: 'image/png' } };
    };
  };
}

const requester = client<RequestsOnly>()(connect(url), binary(), clientRequests());
requester.binary.request('get-thumbnail', { attachmentId: 'att_1' });
// @ts-expect-error: nothing to listen for
requester.binary.on;

interface StreamsOnly {
  binary: { streams: HuddleSocket['binary']['streams'] };
}

const streamer = client<StreamsOnly>()(connect(url), binary(), stream());
streamer.binary.stream('download-attachment', { attachmentId: 'att_1', fromByte: 0 });
// @ts-expect-error: no binary requests
streamer.binary.request;

// With no binary entries, the request and stream primitives add no `.binary`.
interface NoBinary {
  clientRequests: { 'get-room': { payload: { roomId: string }; response: { name: string } } };
  streams: { 'export-room': { payload: { roomId: string }; chunk: { line: string } } };
}

const plain = client<NoBinary>()(connect(url), clientRequests(), stream());
plain.request('get-room', { roomId: 'room:general' });
// @ts-expect-error: no binary entries, so no `.binary`
plain.binary;

// Plugins: the scoped socket gets every binary method its contract has, with plain names.
interface RecorderWire {
  binary: {
    clientRequests: { 'get-clip': { payload: { clipId: string }; response: null } };
    serverRequests: { 'capture-clip': { payload: null; response: { length: number } } };
    streams: { 'download-clip': { payload: null; chunk: null; kind: 'ephemeral' } };
  };
  channels: {
    stage: {
      binary: { clientRequests: { 'get-stage': { payload: null; response: null } } };
    };
  };
}

plugin<RecorderWire>()({
  id: 'acme:recorder',
  dependencies: [binary, channels, clientRequests, serverRequests, stream],
  setup(scoped) {
    expectTypeOf(scoped.binary.request('get-clip', { clipId: 'c1' })).toEqualTypeOf<
      Promise<BinaryItem<null>>
    >();
    scoped.binary.onRequest('capture-clip', (info, bytes) => {
      expectTypeOf(info).toEqualTypeOf<null>();
      expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
      return { info: { length: bytes.byteLength } };
    });
    scoped.binary.stream('download-clip', null);
    scoped.binary.onStream('download-clip', { onChunk: () => {} });
    // @ts-expect-error: the plugin uses plain names
    scoped.binary.request('__acme:recorder::get-clip', { clipId: 'c1' });
    scoped.channel('stage').binary.request('get-stage', null);

    return {};
  },
});

// `BinaryMessaging` is the whole `.binary` key of one scope, for typing a variable.
declare const huddleBinary: BinaryMessaging<HuddleSocket['binary']>;
huddleBinary.on('avatar-preview', () => {});
huddleBinary.request('get-thumbnail', { attachmentId: 'att_1' });
huddleBinary.onRequest('capture-screen', () => ({ info: { fileType: 'image/png' } }));
huddleBinary.stream('download-attachment', { attachmentId: 'att_1', fromByte: 0 });
// @ts-expect-error: the top level sends no binary events
huddleBinary.send;

void download;
