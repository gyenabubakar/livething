import { createHttpHub } from '~/_adapters/http.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpAnswer, HttpHub, HttpPost, HttpUpload } from '~/_adapters/http.ts';
import type { ConnectionHandle } from '~/_adapters/types.ts';

const TEXT = 0;
const PROBE = 2;
const START = 3;

interface Ack {
  seq: number;
  probe?: true;
}

function frame(type: number, data: Uint8Array | string = new Uint8Array(0)): Uint8Array {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const part = new Uint8Array(5 + bytes.byteLength);
  part[0] = type;
  new DataView(part.buffer).setUint32(1, bytes.byteLength, false);
  part.set(bytes, 5);

  return part;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }

  return body;
}

function start(seq: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, seq, false);
  return frame(START, bytes);
}

function sendMessage(text: string): string {
  return JSON.stringify(['send-message', { text }, null]);
}

function texts(...names: string[]): Uint8Array {
  return join(...names.map((name) => frame(TEXT, sendMessage(name))));
}

function open(hub: HttpHub, { settle = true } = {}) {
  const written: string[] = [];
  const stream = hub.openStream({
    write: (chunk) => void written.push(chunk),
    end: vi.fn(),
    bufferedAmount: () => 0,
    backpressureSupported: true,
  });
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

  function acks(): Ack[] {
    return written
      .filter((chunk) => chunk.startsWith('data: ["__ack__"'))
      .map((chunk) => (JSON.parse(chunk.slice(6)) as [string, Ack, null])[1]);
  }

  function received(): string[] {
    return handle.handleMessage.mock.calls.map(
      ([text]) => (JSON.parse(text) as [string, { text: string }])[1].text,
    );
  }

  return { stream, handle, written, pending, acks, received, secret: stream.socket.secret };
}

function upload(hub: HttpHub, secret: string): HttpUpload {
  const started = hub.beginUpload(secret);
  if (!('push' in started)) throw new Error(`upload refused: ${started.status}`);

  return started;
}

function post(secret: string, seq: number, body: Uint8Array): HttpAnswer {
  const started: HttpPost | HttpAnswer = hub.beginPost(secret, 'data', String(seq));
  return 'finish' in started ? started.finish(body) : started;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let hub: HttpHub;
beforeEach(() => {
  vi.useFakeTimers();
  hub = createHttpHub({ maxPostBytes: 1024, receiveBytes: 1 << 20 });
});
afterEach(() => vi.useRealTimers());

describe('createHttpHub: the upload', () => {
  it('acks a probe at once, with the last sequence number it has', () => {
    const { secret, acks } = open(hub);
    post(secret, 1, texts('one', 'two'));

    upload(hub, secret).push(frame(PROBE));

    expect(acks()).toEqual([{ seq: 2, probe: true }]);
  });

  it('hands the frames after the start frame to the engine, in order', () => {
    const { secret, received } = open(hub);

    upload(hub, secret).push(join(frame(PROBE), start(1), texts('one', 'two', 'three')));

    expect(received()).toEqual(['one', 'two', 'three']);
  });

  it('reads a frame split across chunks', () => {
    const { secret, received } = open(hub);
    const body = join(start(1), texts('one', 'two'));
    const uploading = upload(hub, secret);

    for (let i = 0; i < body.byteLength; i += 7) uploading.push(body.subarray(i, i + 7));

    expect(received()).toEqual(['one', 'two']);
  });

  it('coalesces the acks of a burst into one, with the highest sequence number', async () => {
    const { secret, acks } = open(hub);
    const uploading = upload(hub, secret);

    uploading.push(join(start(1), texts('one')));
    uploading.push(texts('two', 'three'));
    expect(acks()).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);

    expect(acks()).toEqual([{ seq: 3 }]);
  });

  it('acks the last frame at once when the body ends, and answers 204', () => {
    const { secret, acks } = open(hub);
    const uploading = upload(hub, secret);
    uploading.push(join(start(1), texts('one', 'two')));

    expect(uploading.finish().status).toBe(204);
    expect(acks()).toEqual([{ seq: 2 }]);
  });

  it('refuses data frames before the start frame, and closes the connection with 1002', async () => {
    const { secret, handle } = open(hub);
    const uploading = upload(hub, secret);

    uploading.push(texts('one'));
    await flush();

    expect(handle.handleMessage).not.toHaveBeenCalled();
    await expect(uploading.stopped).resolves.toMatchObject({ status: 400 });
    expect(handle.handleClose).toHaveBeenCalledWith(1002, expect.any(String));
  });

  it('stops the upload when a frame is over maxPostBytes', async () => {
    const { secret } = open(hub);
    const uploading = upload(hub, secret);

    uploading.push(join(start(1), frame(TEXT, sendMessage('x'.repeat(1100)))));

    await expect(uploading.stopped).resolves.toMatchObject({ status: 413 });
  });

  it('stops an upload that sends nothing for 45 seconds', async () => {
    const { secret } = open(hub);
    const uploading = upload(hub, secret);
    uploading.push(frame(PROBE));

    await vi.advanceTimersByTimeAsync(44_000);
    uploading.push(frame(PROBE));
    await vi.advanceTimersByTimeAsync(44_000);
    let stopped = false;
    void uploading.stopped.then(() => (stopped = true));

    await flush();
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(uploading.stopped).resolves.toMatchObject({ status: 408 });
  });

  it('stops the upload when its connection closes', async () => {
    const { secret, stream } = open(hub);
    const uploading = upload(hub, secret);

    stream.socket.close(1000, 'bye');

    await expect(uploading.stopped).resolves.toMatchObject({ status: 410 });
  });
});

describe('createHttpHub: the data lane and the sequence numbers', () => {
  it('lets a POST take the data lane from an open upload, with no close', async () => {
    const { secret, handle, received } = open(hub);
    const uploading = upload(hub, secret);
    uploading.push(join(start(1), texts('one')));

    expect(post(secret, 2, texts('two')).status).toBe(204);
    await flush();

    await expect(uploading.stopped).resolves.toMatchObject({ status: 409 });
    expect(handle.handleClose).not.toHaveBeenCalled();
    expect(received()).toEqual(['one', 'two']);
  });

  it('drops the frames of a POST that the upload already handed over', () => {
    const { secret, received } = open(hub);
    upload(hub, secret).push(join(start(1), texts('one', 'two', 'three')));

    // The upload died before its ack came, so the client resends from seq 2.
    expect(post(secret, 2, texts('two', 'three', 'four')).status).toBe(204);

    expect(received()).toEqual(['one', 'two', 'three', 'four']);
  });

  it('drops the frames of an upload that a POST already handed over', () => {
    const { secret, received } = open(hub);
    post(secret, 1, texts('one', 'two'));

    upload(hub, secret).push(join(start(2), texts('two', 'three')));

    expect(received()).toEqual(['one', 'two', 'three']);
  });

  it('lets a fresh upload take over from the old one, with no frame handled twice', async () => {
    const { secret, handle, received } = open(hub);
    const old = upload(hub, secret);
    old.push(join(start(1), texts('one', 'two')));

    // The client renews: the fresh upload starts again at the first frame without an ack.
    const fresh = upload(hub, secret);
    fresh.push(join(start(2), texts('two', 'three')));
    old.push(texts('late'));
    await flush();

    await expect(old.stopped).resolves.toMatchObject({ status: 409 });
    expect(handle.handleClose).not.toHaveBeenCalled();
    expect(received()).toEqual(['one', 'two', 'three']);
    expect(fresh.finish().status).toBe(204);
  });

  it('acks a fresh upload that carries only frames the old one handed over', async () => {
    const { secret, acks } = open(hub);
    upload(hub, secret).push(join(start(1), texts('one', 'two')));

    upload(hub, secret).push(join(start(1), texts('one', 'two')));
    await vi.advanceTimersByTimeAsync(100);

    expect(acks()).toEqual([{ seq: 2 }]);
  });

  it('closes the connection with 1002 when frames are missing', async () => {
    const { secret, handle } = open(hub);
    post(secret, 1, texts('one'));

    expect(post(secret, 3, texts('three')).status).toBe(400);
    await flush();

    expect(handle.handleClose).toHaveBeenCalledWith(1002, expect.any(String));
  });

  it('refuses a start frame with sequence number 0, and closes the connection with 1002', async () => {
    const { secret, handle } = open(hub);
    const uploading = upload(hub, secret);

    uploading.push(join(start(0), texts('one', 'two')));
    await flush();

    expect(handle.handleMessage).not.toHaveBeenCalled();
    await expect(uploading.stopped).resolves.toMatchObject({ status: 400 });
    expect(handle.handleClose).toHaveBeenCalledWith(1002, expect.any(String));
  });

  it('refuses a data POST with no sequence number', async () => {
    const { secret } = open(hub);
    const started = hub.beginPost(secret, 'data', null);

    expect('finish' in started ? started.finish(texts('one')) : started).toMatchObject({
      status: 400,
    });
  });
});

describe('createHttpHub: upload backpressure', () => {
  it('stops reading while the connection has no room, and goes on when room comes back', async () => {
    const { secret, handle, pending } = open(hub, { settle: false });
    const uploading = upload(hub, secret);
    const names = Array.from({ length: 300 }, (_, i) => `m${i}`);

    const wait = uploading.push(join(start(1), texts(...names)));

    expect(wait).toBeInstanceOf(Promise);
    expect(handle.handleMessage).toHaveBeenCalledTimes(255);

    for (const resolve of pending.splice(0, 100)) resolve();
    await wait;

    expect(handle.handleMessage).toHaveBeenCalledTimes(300);
  });

  it('does not ask the reader to wait when there is room', () => {
    const { secret } = open(hub);

    expect(upload(hub, secret).push(join(start(1), texts('one')))).toBeNull();
  });

  it('does not stop an upload as idle while it waits for room on the server', async () => {
    const { secret, handle, pending } = open(hub, { settle: false });
    const uploading = upload(hub, secret);
    const names = Array.from({ length: 256 }, (_, i) => `m${i}`);
    let stopped = false;
    void uploading.stopped.then(() => (stopped = true));

    const wait = uploading.push(join(start(1), texts(...names)));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stopped).toBe(false);
    for (const resolve of pending.splice(0)) resolve();
    await wait;
    expect(handle.handleMessage).toHaveBeenCalledTimes(256);

    await vi.advanceTimersByTimeAsync(44_000);
    expect(stopped).toBe(false);
  });
});

describe('createHttpHub: upload chunks', () => {
  it('keeps the bytes of a frame that is not whole when the adapter reuses its chunk buffer', () => {
    const { secret, received } = open(hub);
    const uploading = upload(hub, secret);
    const body = join(start(1), texts('reused'));
    const reused = Buffer.alloc(7);

    for (let at = 0; at < body.byteLength; at += reused.byteLength) {
      const part = body.subarray(at, at + reused.byteLength);
      reused.set(part);
      uploading.push(reused.subarray(0, part.byteLength));
      reused.fill(0);
    }

    expect(received()).toEqual(['reused']);
  });

  it('reads a big frame sent in small chunks in linear time', () => {
    vi.useRealTimers();
    const big = createHttpHub({ maxPostBytes: 8 << 20, receiveBytes: 32 << 20 });
    const { secret, received } = open(big);
    const uploading = upload(big, secret);
    const body = join(start(1), frame(TEXT, sendMessage('x'.repeat((8 << 20) - 64))));

    const began = performance.now();
    for (let at = 0; at < body.byteLength; at += 4096) {
      uploading.push(body.subarray(at, at + 4096));
    }

    const took = performance.now() - began;

    expect(received()).toHaveLength(1);
    expect(took).toBeLessThan(1_000);
  });
});
