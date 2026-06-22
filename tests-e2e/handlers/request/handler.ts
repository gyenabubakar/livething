import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { requests } from '@wskit/server/requests';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const requestContract = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [requests(), channels()],
});

const handleGetTime = requestContract.request('get-time', {
  input: v.object({}),
  run() {
    return { now: 'fixed-now-string' };
  },
});

const handleNoResponse = requestContract.request('no-response', {
  input: v.object({}),
  // Intentionally never produce a value - the server surfaces a correlated
  // __error__ with code "request-no-response" so the client's pending promise
  // rejects instead of hanging. The annotated return type keeps the client
  // contract { ok: boolean } even though nothing is returned at runtime.
  run(): { ok: boolean } {
    return undefined as unknown as { ok: boolean };
  },
});

const handleDoubleResponse = requestContract.request('double-response', {
  input: v.object({}),
  run() {
    return { count: 1 };
  },
});

const handleStrictEcho = requestContract.request('strict-echo', {
  input: v.strictObject({ id: v.string() }),
  run(_ctx, input) {
    return { echoed: input.id };
  },
});

const handleThrowingRequest = requestContract.request('throwing-request', {
  input: v.object({}),
  run(): { never: string } {
    throw new Error('intentional handler throw');
  },
});

const handleEchoAnything = requestContract.request('echo-anything-req', {
  run(_ctx, input) {
    return { got: input };
  },
});

const handleHang = requestContract.request('hang', {
  input: v.object({}),
  async run(): Promise<{ never: string }> {
    await new Promise<void>(() => {});
    return { never: '' };
  },
});

const room = requestContract.channel('room');

const handleGetChannelInfo = room.request('get-channel-info', {
  input: v.object({}),
  run(ctx) {
    return { channel: ctx.channel.name };
  },
});

export const requestHandler = requestContract.assemble(
  handleGetTime,
  handleNoResponse,
  handleDoubleResponse,
  handleStrictEcho,
  handleThrowingRequest,
  handleEchoAnything,
  handleHang,
  handleGetChannelInfo,
);

export type RequestClient = InferClient<typeof requestHandler>;
