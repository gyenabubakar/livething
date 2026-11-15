import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { sendToWs } from './socket.ts';

function recorder() {
  const sent: { data: string | Uint8Array; binary: boolean | undefined }[] = [];
  const socket = {
    send(data: string | Uint8Array, options?: { binary?: boolean }) {
      sent.push({ data, binary: options?.binary });
    },
  } as unknown as Pick<WebSocket, 'send'>;

  return { sent, socket };
}

describe('sendToWs', () => {
  it('sends a frame for one socket as a string', () => {
    const { sent, socket } = recorder();

    sendToWs(socket, { kind: 'text', text: '["echoed",{},null]', shared: false });

    expect(sent).toEqual([{ data: '["echoed",{},null]', binary: undefined }]);
  });

  it('turns a shared frame into bytes once and sends them as text from the second socket on', () => {
    const frame = { kind: 'text', text: '["message",{"text":"hé"},null]', shared: true } as const;
    const first = recorder();
    const second = recorder();
    const third = recorder();

    sendToWs(first.socket, frame);
    sendToWs(second.socket, frame);
    sendToWs(third.socket, frame);

    expect(first.sent[0]).toEqual({ data: frame.text, binary: undefined });
    expect(second.sent[0]!.binary).toBe(false);
    expect(Buffer.from(second.sent[0]!.data as Uint8Array).toString()).toBe(frame.text);
    expect(third.sent[0]!.data).toBe(second.sent[0]!.data);
  });

  it('sends a bytes frame as binary', () => {
    const { sent, socket } = recorder();
    const bytes = new Uint8Array([1, 2, 3]);

    sendToWs(socket, { kind: 'bytes', bytes });

    expect(sent).toEqual([{ data: bytes, binary: undefined }]);
  });
});
