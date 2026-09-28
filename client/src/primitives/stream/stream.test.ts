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
      nudges: { cancel: { reason: string }; pause: undefined };
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

  // A nudge with no payload is sent by name, with or without options.
  void handle.nudge('pause');
  void handle.nudge('pause', undefined, { timeout: 1000 });

  // @ts-expect-error — 'cancel' needs its payload
  void handle.nudge('cancel');

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

  const continued = socket.continueStream('ask-ai', 'stream-1');
  for await (const chunk of continued) {
    const _t: string = chunk.text;
    void _t;
  }

  // @ts-expect-error — 'nope' is not a declared stream
  void socket.continueStream('nope', 'stream-1');

  const withChannels = client<C>()(connect('wss://x'), stream(), channels());
  const room = withChannels.channel('rooms', 'r1');
  const roomStream = await room.stream('ask-ai', { prompt: 'hi' });
  for await (const chunk of roomStream) {
    const _t: string = chunk.text;
    void _t;
  }

  const roomContinued = room.continueStream('ask-ai', 'stream-2');
  for await (const chunk of roomContinued) {
    const _t: string = chunk.text;
    void _t;
  }
}

void main;
