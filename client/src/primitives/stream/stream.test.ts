/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
// Type-only checks for the stream surface. tsc checks these; vitest never runs them.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { stream } from '~/primitives/stream/index.ts';

interface C {
  streams: {
    'ask-ai': {
      payload: { prompt: string };
      chunk: { text: string };
      kind: 'persistent';
      nudges: { cancel: { reason: string } };
    };
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: { msg: { text: string } };
      outgoing: { say: { text: string } };
      streams: {
        'ask-ai': { payload: { prompt: string }; chunk: { text: string }; kind: 'persistent' };
      };
    };
  };
}

async function main() {
  const socket = client<C>()(connect('wss://x'), stream());

  const handle = await socket.stream('ask-ai', { prompt: 'hi' });
  for await (const chunk of handle) {
    const _t: string = chunk.text;
    void _t;
  }
  const _nudged: Promise<void> = handle.nudge('cancel', { reason: 'stop' }, { timeout: 5000 });
  void _nudged;
  handle.cancel();
  const _id: string = handle.streamId;
  void _id;

  // @ts-expect-error — wrong trigger payload
  void socket.stream('ask-ai', { wrong: true });

  // @ts-expect-error — 'nope' is not a declared stream
  void socket.stream('nope', {});

  // @ts-expect-error — 'add-context' is not a declared nudge
  handle.nudge('add-context', {});

  socket.onStream('ask-ai', {
    onChunk(chunk, streamId) {
      const _t: string = chunk.text;
      const _s: string = streamId;
      void _t;
      void _s;
    },
    onEnd(streamId, finalSeq) {
      const _s: string = streamId;
      const _n: number | undefined = finalSeq;
      void _s;
      void _n;
    },
  });

  const resumed = socket.resumeStream('ask-ai', 'stream-1');
  for await (const chunk of resumed) {
    const _t: string = chunk.text;
    void _t;
  }

  // @ts-expect-error — 'nope' is not a declared stream
  void socket.resumeStream('nope', 'stream-1');

  const withChannels = client<C>()(connect('wss://x'), stream(), channels());
  const room = withChannels.channel('rooms', 'r1');
  const roomStream = await room.stream('ask-ai', { prompt: 'hi' });
  for await (const chunk of roomStream) {
    const _t: string = chunk.text;
    void _t;
  }

  const roomResumed = room.resumeStream('ask-ai', 'stream-2');
  for await (const chunk of roomResumed) {
    const _t: string = chunk.text;
    void _t;
  }
}
void main;
