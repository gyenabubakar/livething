import { bufferStreamNudge, cancelStream, runStream } from '~/stream/runtime.ts';
import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

function createConnection() {
  return {
    id: 'conn_1',
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    wsKey: Symbol('ws'),
    meta: {},
    tags: new Set<string>(),
    channels: new Set<string>(),
    latency: null,
    quality: 'good' as const,
  };
}

function createRuntime() {
  const protocol: { event: string; payload: Record<string, unknown> }[] = [];
  const sent: { event: string; payload: unknown; routing?: Record<string, unknown> }[] = [];
  const validationErrors: unknown[] = [];
  const runtimeErrors: { event?: string; routing?: Record<string, unknown> }[] = [];

  return {
    protocol,
    sent,
    validationErrors,
    runtimeErrors,
    runtime: {
      activeStreams: new Map(),
      generateId() {
        return 'stream_1';
      },
      buildConnectionContext() {
        return {};
      },
      sendProtocolMessage(_connection: unknown, event: string, payload: Record<string, unknown>) {
        protocol.push({ event, payload });
      },
      sendThroughPipeline(
        _connection: unknown,
        routing: Record<string, unknown> | undefined,
        event: string,
        payload: unknown,
      ) {
        sent.push({ event, payload, routing });
        return true;
      },
      setActiveConnectionId() {},
      async handleRuntimeError(
        _connection: unknown,
        _error: unknown,
        event?: string,
        routing?: Record<string, unknown>,
      ) {
        runtimeErrors.push({ event, routing });
      },
      async handleValidationError(_connection: unknown, _event: string, error: unknown) {
        validationErrors.push(error);
      },
    },
  };
}

describe('stream runtime', () => {
  it('starts a stream, forwards chunks, and sends _streamEnd', async () => {
    const streamDecl = stream(
      start('ask-ai', (value: unknown) => value as { prompt: string }),
      chunks(t<{ text: string }>()),
      nudge('add-context', (value: unknown) => value as { text: string }),
    );
    const handler = generate(streamDecl, async function* (_ctx, payload) {
      yield { text: payload.prompt };
    });
    const { runtime, protocol, sent } = createRuntime();

    await runStream(runtime, createConnection(), {}, 'ask-ai', handler, { prompt: 'hello' });

    expect(protocol).toEqual([
      { event: '_streamOk', payload: { _streamId: 'stream_1' } },
      { event: '_streamEnd', payload: { _streamId: 'stream_1' } },
    ]);
    expect(sent).toEqual([
      {
        event: 'ask-ai',
        payload: { text: 'hello' },
        routing: { streamId: 'stream_1' },
      },
    ]);
    expect(runtime.activeStreams.size).toBe(0);
  });

  it('buffers validated nudges for the active stream', async () => {
    const { runtime, validationErrors } = createRuntime();
    runtime.activeStreams.set('stream_1', {
      id: 'stream_1',
      connectionId: 'conn_1',
      generator: (async function* () {})(),
      nudges: [],
      nudgeValidators: new Map([['add-context', (value: unknown) => value as { text: string }]]),
      closed: false,
    });

    const handled = await bufferStreamNudge(runtime, createConnection(), 'add-context', {
      _streamId: 'stream_1',
      text: 'more',
    });

    expect(handled).toBe(true);
    expect(validationErrors).toEqual([]);
    expect(runtime.activeStreams.get('stream_1')?.nudges).toEqual([
      { event: 'add-context', payload: { text: 'more' } },
    ]);
  });

  it('cancels a live stream owned by the connection', async () => {
    let returned = false;
    const { runtime } = createRuntime();
    const generator = (async function* () {
      yield undefined;
    })();
    generator.return = async () => {
      returned = true;
      return { done: true, value: undefined };
    };

    runtime.activeStreams.set('stream_1', {
      id: 'stream_1',
      connectionId: 'conn_1',
      generator,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    });

    await cancelStream(runtime, createConnection(), { _streamId: 'stream_1' });

    expect(returned).toBe(true);
    expect(runtime.activeStreams.size).toBe(0);
  });
});
