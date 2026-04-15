import { server } from '~/_builder/server-builder.ts';
import { withAck } from '~/ack/with.ts';
import { withChannels } from '~/channel/with.ts';
import { event } from '~/event.ts';
import { withStreams } from '~/stream/with.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const aiComplete = event('ai-complete', (p: unknown) => p as { prompt: string });
const cancel = event('cancel', (p: unknown) => p as {});
const addContext = event('add-context', (p: unknown) => p as { context: string });
function chunkSchema(p: unknown) {
  return p as { token: string };
}

describe('.stream() side-effect', () => {
  it('adds stream + generate primitives', () => {
    const def = withStreams(server('chat'))
      .stream(aiComplete, chunkSchema, (s) =>
        s.generate(async function* (_ctx, payload) {
          yield { token: payload.prompt };
        }),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'stream')).toBe(true);
    expect(def.primitives.some((p) => p.__wskit === 'generate')).toBe(true);
  });

  it('types generator ctx from parent builder state', () => {
    withAck(withStreams(server('chat')))
      .ack()
      .outgoing(message)
      .stream(aiComplete, chunkSchema, (s) =>
        s.generate(async function* (ctx, payload) {
          ctx.send('message', { text: 'starting' });
          yield { token: payload.prompt };
        }),
      );
  });

  it('types generator payload from event schema', () => {
    withStreams(server('chat')).stream(aiComplete, chunkSchema, (s) =>
      s.generate(async function* (_ctx, payload) {
        const prompt: string = payload.prompt;
        void prompt;

        // @ts-expect-error — 'nonexistent' not on payload
        payload.nonexistent;

        yield { token: 'hi' };
      }),
    );
  });

  it('supports nudges', () => {
    const def = withStreams(server('chat'))
      .stream(aiComplete, chunkSchema, (s) =>
        s
          .nudge(cancel)
          .nudge(addContext)
          .generate(async function* (ctx, payload) {
            const nudges = ctx.nudges(yield { token: payload.prompt });
            for (const n of nudges) {
              if (n.event === 'cancel') return;
            }
          }),
      )
      .build();

    const streamPrim = def.primitives.find((p) => p.__wskit === 'stream') as unknown as {
      nudges: readonly { event: string }[];
    };
    expect(streamPrim.nudges).toHaveLength(2);
    expect(streamPrim.nudges[0]!.event).toBe('cancel');
    expect(streamPrim.nudges[1]!.event).toBe('add-context');
  });

  it('supports broadcast option', () => {
    const def = withStreams(server('chat'))
      .stream(aiComplete, chunkSchema, { broadcast: true }, (s) =>
        s.generate(async function* (_ctx, payload) {
          yield { token: payload.prompt };
        }),
      )
      .build();

    const streamPrim = def.primitives.find((p) => p.__wskit === 'stream') as unknown as {
      broadcast: boolean;
    };
    expect(streamPrim.broadcast).toBe(true);
  });

  it('callback form returns to parent for continued chaining', () => {
    const def = withStreams(server('chat'))
      .outgoing(message)
      .stream(aiComplete, chunkSchema, (s) =>
        s.generate(async function* (_ctx, payload) {
          yield { token: payload.prompt };
        }),
      )
      .incoming(
        event('send', (p: unknown) => p as { text: string }),
        async (ctx) => {
          ctx.send('message', { text: 'after stream' });
        },
      )
      .build();

    expect(def.primitives).toHaveLength(4);
  });

  it('works with GroupBuilder', () => {
    const base = withAck(withStreams(server('chat')))
      .ack()
      .outgoing(message);
    const def = base
      .use(
        base.group((g) =>
          g.stream(aiComplete, chunkSchema, (s) =>
            s.generate(async function* (ctx, payload) {
              ctx.send('message', { text: 'streaming' });
              yield { token: payload.prompt };
            }),
          ),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'stream')).toBe(true);
    expect(def.primitives.some((p) => p.__wskit === 'generate')).toBe(true);
  });

  it('works with ChannelBuilder', () => {
    const base = withStreams(withChannels(server('chat'))).outgoing(message);
    const def = base
      .use(
        base.channel('lobby', (c) =>
          c.outgoing(message).stream(aiComplete, chunkSchema, (s) =>
            s.generate(async function* (ctx, payload) {
              ctx.channel.send('message', { text: 'streaming' });
              ctx.channel.broadcast('message', { text: 'all' });
              yield { token: payload.prompt };
            }),
          ),
        ),
      )
      .build();

    expect(def.primitives.some((p) => p.__wskit === 'channel')).toBe(true);
  });

  it('channel stream ctx rejects undeclared events', () => {
    const base = withStreams(withChannels(server('chat')));
    base.channel('lobby', (c) =>
      c.outgoing(message).stream(aiComplete, chunkSchema, (s) =>
        s.generate(async function* (ctx, payload) {
          // @ts-expect-error — 'unknown-event' not declared in this channel
          ctx.channel.send('unknown-event', {});
          yield { token: payload.prompt };
        }),
      ),
    );
  });
});
