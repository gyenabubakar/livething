import { encodeBinaryFrame } from '@livething/core';
import { createSseHub, sseCloseEvent } from '~/_adapters/sse.ts';
import { describe, expect, it, vi } from 'vitest';
import type { SseAnswer, SseHub, SsePost } from '~/_adapters/sse.ts';
import type { ConnectionHandle } from '~/_adapters/types.ts';

function batch(...frames: (string | Uint8Array)[]): Uint8Array {
  const parts = frames.map((frame) => {
    const data = typeof frame === 'string' ? new TextEncoder().encode(frame) : frame;
    const part = new Uint8Array(5 + data.byteLength);
    part[0] = typeof frame === 'string' ? 0 : 1;
    new DataView(part.buffer).setUint32(1, data.byteLength, false);
    part.set(data, 5);

    return part;
  });
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }

  return body;
}

function sendMessage(text: string): string {
  return JSON.stringify(['sendMessage', { text }, null]);
}

function open(hub: SseHub, { settle = true } = {}) {
  const written: string[] = [];
  const sink = { write: vi.fn((chunk: string) => written.push(chunk)), end: vi.fn() };
  const stream = hub.openStream({ ...sink, bufferedAmount: () => 0, backpressureSupported: true });
  const pending: (() => void)[] = [];
  const handle = {
    handleMessage: vi.fn((_text: string) =>
      settle ? Promise.resolve() : new Promise<void>((resolve) => pending.push(resolve)),
    ),
    handleBinaryMessage: vi.fn(() => Promise.resolve()),
    handleClose: vi.fn(() => Promise.resolve()),
    handleError: vi.fn(() => Promise.resolve()),
  } satisfies ConnectionHandle;

  stream.attach(handle);

  return { stream, handle, written, sink, pending, secret: stream.socket.secret };
}

/** The answer to a POST: its early refusal, or what its body got. */
function postNow(started: SsePost | SseAnswer, body: Uint8Array): SseAnswer {
  return 'finish' in started ? started.finish(body) : started;
}

function flush(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('sseCloseEvent', () => {
  it('cuts the reason to 123 UTF-8 bytes, as a WebSocket close does', () => {
    const event = sseCloseEvent(4002, '🙂'.repeat(100));
    const [, payload] = JSON.parse(event.slice('data: '.length)) as [string, { reason: string }];

    expect(payload.reason).toBe('🙂'.repeat(30));
  });
});

describe('createSseHub: the stream', () => {
  it('writes a text frame as one data line, and a binary frame as b and base64', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { stream, written } = open(hub);

    stream.socket.send({ kind: 'text', text: '["messageCreated",{},null]' });
    stream.socket.send({ kind: 'bytes', bytes: new Uint8Array([1, 2, 255]) });

    expect(written).toEqual(['data: ["messageCreated",{},null]\n\n', 'data: bAQL/\n\n']);
  });

  it('gives the engine its secret and maxPostBytes', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { stream } = open(hub);

    expect(stream.socket.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stream.socket.maxPostBytes).toBe(1024);
  });

  it('ends a server close with a __close__ frame, and tells the engine the code it sent', async () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { stream, handle, written, sink, secret } = open(hub);

    stream.socket.close(4004, 'idle');
    await flush();

    expect(written.at(-1)).toBe('data: ["__close__",{"code":4004,"reason":"idle"},null]\n\n');
    expect(sink.end).toHaveBeenCalledOnce();
    expect(handle.handleClose).toHaveBeenCalledWith(4004, 'idle');
    expect(stream.socket.send({ kind: 'text', text: 'ping' })).toBe(false);
    expect(postNow(hub.beginPost(secret, 'control'), batch('pong')).status).toBe(404);
  });

  it('reports a stream that ended with no close as 1006', async () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { stream, handle } = open(hub);

    stream.ended();
    await flush();

    expect(handle.handleClose).toHaveBeenCalledWith(1006, 'stream ended');
  });
});

describe('createSseHub: POSTs', () => {
  it('answers 404 for a secret it does not know', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });

    expect(hub.beginPost('nope', 'data')).toMatchObject({
      status: 404,
      headers: { 'LiveThing-Error': 'unknown-connection' },
    });
    expect(hub.beginPost(null, 'data')).toMatchObject({ status: 404 });
  });

  it('hands text and binary frames to the engine in order, then answers 204', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { handle, secret } = open(hub);
    const order: string[] = [];
    handle.handleMessage.mockImplementation((text: string) => {
      order.push(text);
      return Promise.resolve();
    });
    handle.handleBinaryMessage.mockImplementation(() => {
      order.push('binary');
      return Promise.resolve();
    });

    const bytes = encodeBinaryFrame(
      JSON.stringify(['avatarUploaded', null, null]),
      new Uint8Array([7]),
    );

    const answer = postNow(
      hub.beginPost(secret, 'data'),
      batch(sendMessage('a'), bytes, sendMessage('b')),
    );

    expect(answer.status).toBe(204);
    expect(order).toEqual([sendMessage('a'), 'binary', sendMessage('b')]);
    expect(handle.handleBinaryMessage).toHaveBeenCalledWith(bytes);
  });

  // A WebSocket hands the engine a text frame as it came, so a leading BOM stays.
  it('keeps a leading BOM in a text frame', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { handle, secret } = open(hub);

    postNow(hub.beginPost(secret, 'data'), batch(`﻿${sendMessage('a')}`));

    expect(handle.handleMessage).toHaveBeenCalledWith(`﻿${sendMessage('a')}`);
  });

  it('frees the lane before it answers, so the next POST in the lane is accepted', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { secret } = open(hub);

    expect(postNow(hub.beginPost(secret, 'data'), batch(sendMessage('a'))).status).toBe(204);
    expect(postNow(hub.beginPost(secret, 'data'), batch(sendMessage('b'))).status).toBe(204);
  });

  it('refuses a second POST in one lane with 409 and closes the connection', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { written, secret } = open(hub);
    const first = hub.beginPost(secret, 'data') as SsePost;

    expect(hub.beginPost(secret, 'control')).toHaveProperty('finish');
    expect(hub.beginPost(secret, 'data')).toMatchObject({
      status: 409,
      headers: { 'LiveThing-Error': 'lane-busy' },
    });
    expect(written.at(-1)).toContain('"code":1002');
    expect(first.finish(batch(sendMessage('late'))).status).toBe(204);
  });

  it('frees the lane when the body could not be read', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { secret } = open(hub);

    (hub.beginPost(secret, 'data') as SsePost).cancel();

    expect(postNow(hub.beginPost(secret, 'data'), batch(sendMessage('a'))).status).toBe(204);
  });

  it.each([null, 'fast', 'DATA'])('refuses the lane %j with 400 and closes with 1002', (lane) => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { written, secret } = open(hub);

    expect(hub.beginPost(secret, lane)).toMatchObject({ status: 400 });
    expect(written.at(-1)).toContain('"code":1002');
  });

  it.each([
    ['a header cut short', new Uint8Array([0, 0, 0])],
    ['a length past the end', new Uint8Array([0, 0, 0, 0, 9, 1])],
    ['an unknown frame type', new Uint8Array([2, 0, 0, 0, 0])],
    ['text that is not UTF-8', new Uint8Array([0, 0, 0, 0, 1, 0xff])],
  ])('refuses %s with 400 and closes with 1002', (_name, body) => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { written, secret } = open(hub);

    expect(postNow(hub.beginPost(secret, 'data'), body)).toMatchObject({
      status: 400,
      headers: { 'LiveThing-Error': 'bad-batch' },
    });
    expect(written.at(-1)).toContain('"code":1002');
  });
});

describe('createSseHub: the control lane', () => {
  it('passes ping and pong to the engine', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { handle, secret } = open(hub);

    expect(postNow(hub.beginPost(secret, 'control'), batch('pong', 'ping')).status).toBe(204);
    expect(handle.handleMessage.mock.calls).toEqual([['pong'], ['ping']]);
  });

  it("closes on the client's __close__ with its code, ends the stream and forgets the secret", async () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { handle, sink, written, secret } = open(hub);
    const close = JSON.stringify(['__close__', { code: 4000, reason: 'leaving' }, null]);

    expect(postNow(hub.beginPost(secret, 'control'), batch(close)).status).toBe(204);
    await flush();

    expect(handle.handleClose).toHaveBeenCalledWith(4000, 'leaving');
    expect(handle.handleMessage).not.toHaveBeenCalled();
    expect(sink.end).toHaveBeenCalledOnce();
    expect(written.join('')).not.toContain('__close__');
    expect(hub.beginPost(secret, 'data')).toMatchObject({ status: 404 });
  });

  // The same rule a WebSocket server applies to a client's close frame.
  it.each([1006, 1001, 999, 0, -1, 5000, 99_999])(
    "refuses a client's __close__ with code %i with 400 and closes with 1002",
    (code) => {
      const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
      const { handle, written, secret } = open(hub);
      const close = JSON.stringify(['__close__', { code, reason: 'leaving' }, null]);

      expect(postNow(hub.beginPost(secret, 'control'), batch(close)).status).toBe(400);
      expect(handle.handleClose).not.toHaveBeenCalledWith(code, 'leaving');
      expect(written.at(-1)).toContain('"code":1002');
    },
  );

  it("cuts a client's close reason to 123 bytes", async () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { handle, secret } = open(hub);
    const close = JSON.stringify(['__close__', { code: 1000, reason: 'x'.repeat(500) }, null]);

    expect(postNow(hub.beginPost(secret, 'control'), batch(close)).status).toBe(204);
    await flush();

    expect(handle.handleClose).toHaveBeenCalledWith(1000, 'x'.repeat(123));
  });

  it('refuses an app frame with 400 and closes with 1002', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 });
    const { handle, written, secret } = open(hub);

    expect(postNow(hub.beginPost(secret, 'control'), batch('pong', sendMessage('a'))).status).toBe(
      400,
    );
    expect(handle.handleMessage).not.toHaveBeenCalled();
    expect(written.at(-1)).toContain('"code":1002');
  });
});

describe('createSseHub: the busy answer', () => {
  function fill(hub: SseHub, count: number) {
    const opened = open(hub, { settle: false });
    const frames = Array.from({ length: count }, (_, i) => sendMessage(String(i)));
    expect(postNow(hub.beginPost(opened.secret, 'data'), batch(...frames)).status).toBe(204);
    return opened;
  }

  it('refuses a batch that does not fit beside the frames in flight, and hands over none of it', () => {
    const hub = createSseHub({ maxPostBytes: 64 * 1024, receiveBytes: 1024 * 1024 });
    const { handle, secret } = fill(hub, 250);

    const answer = postNow(
      hub.beginPost(secret, 'data'),
      batch(...Array(10).fill(sendMessage('x'))),
    );

    expect(answer).toEqual({
      status: 503,
      headers: { 'LiveThing-Error': 'busy', 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: 5, retryAfterMs: 250 }),
    });
    expect(handle.handleMessage).toHaveBeenCalledTimes(250);
  });

  it('makes room again when the engine finishes frames', async () => {
    const hub = createSseHub({ maxPostBytes: 64 * 1024, receiveBytes: 1024 * 1024 });
    const { pending, secret } = fill(hub, 255);
    expect(postNow(hub.beginPost(secret, 'data'), batch(sendMessage('x'))).status).toBe(503);

    pending.splice(0, 3).forEach((resolve) => resolve());
    await flush();

    expect(postNow(hub.beginPost(secret, 'data'), batch(sendMessage('x'))).status).toBe(204);
  });

  it('counts bytes as well as frames', () => {
    const hub = createSseHub({ maxPostBytes: 1024, receiveBytes: 1024 });
    const big = sendMessage('x'.repeat(600));
    const { secret } = fill(hub, 2);

    expect(JSON.parse(postNow(hub.beginPost(secret, 'data'), batch(big, big)).body!)).toEqual({
      room: 1,
      retryAfterMs: 250,
    });
  });

  it('lets in frames that do not wait in line, behind a full queue', () => {
    const hub = createSseHub({ maxPostBytes: 64 * 1024, receiveBytes: 1024 * 1024 });
    const { handle, secret } = fill(hub, 255);
    const answer = JSON.stringify([
      'confirmDelete',
      { ok: true },
      { exchange: { id: 'r1', source: 'server' } },
    ]);
    const binaryAnswer = encodeBinaryFrame(
      JSON.stringify(['pickAvatar', null, { exchange: { id: 'r2', source: 'server' } }]),
      new Uint8Array([1]),
    );
    const leave = JSON.stringify(['__unsubscribe__', { channel: 'room:design' }, null]);

    expect(
      postNow(hub.beginPost(secret, 'data'), batch(answer, binaryAnswer, leave, 'pong')).status,
    ).toBe(204);
    expect(handle.handleBinaryMessage).toHaveBeenCalledOnce();
    expect(postNow(hub.beginPost(secret, 'control'), batch('pong')).status).toBe(204);
  });

  it('counts a __subscribe__, which waits for its check', () => {
    const hub = createSseHub({ maxPostBytes: 64 * 1024, receiveBytes: 1024 * 1024 });
    const { secret } = fill(hub, 255);
    const join = JSON.stringify(['__subscribe__', { channel: 'room:design' }, null]);

    expect(postNow(hub.beginPost(secret, 'data'), batch(join)).status).toBe(503);
  });
});
