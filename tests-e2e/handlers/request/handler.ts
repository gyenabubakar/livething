import { define, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { clientRequests } from '@wskit/server/client-requests';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const requestContract = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [clientRequests(), channels()],
});

const handleGetTime = requestContract.request('get-time', {
  input: v.object({}),
  run() {
    return { now: 'fixed-now-string' };
  },
});

const handleNoResponse = requestContract.request('no-response', {
  input: v.object({}),
  // Returns nothing — a void acknowledgement. The server sends an empty
  // correlated frame and the client's request() resolves with no value, rather
  // than rejecting. The response type is inferred as void.
  run() {},
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

export const requestHandler = requestContract.assemble({
  handlers: [
    handleGetTime,
    handleNoResponse,
    handleDoubleResponse,
    handleStrictEcho,
    handleThrowingRequest,
    handleEchoAnything,
    handleHang,
    handleGetChannelInfo,
  ],
});

export type RequestClient = InferClient<typeof requestHandler>;
