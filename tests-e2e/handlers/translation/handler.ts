import { emits, errors, server, t, translator } from '@livething/server';
import { error } from '@livething/server/errors';
import { requireUsername } from '@livething/tests-e2e-handlers/_shared/upgrade';
import * as v from 'valibot';

const ForeignFrame = v.object({
  type: v.literal('send'),
  name: v.union([
    v.literal('echo'),
    v.literal('server-error'),
    v.literal('throw'),
    v.literal('outbound-throw'),
  ]),
  body: v.union([v.object({ text: v.string() }), v.strictObject({})]),
});

const ForeignError = error('foreign-error', v.object({ reason: v.string() }));

const foreignProtocol = translator(() => {
  let sequence = 0;

  return {
    input: ForeignFrame,
    inbound(frame) {
      if (frame.name === 'throw') throw new Error('inbound failure');

      if (frame.name === 'echo') {
        const body = frame.body as { text: string };
        return JSON.stringify(['echo', { text: body.text, translatorSequence: ++sequence }, null]);
      }

      return JSON.stringify([frame.name, {}, null]);
    },
    outbound(outgoing) {
      const frame = JSON.parse(outgoing) as [string, unknown, unknown];
      if (frame[0] === 'outbound-throw') throw new Error('outbound failure');

      return JSON.stringify({ type: 'message', name: frame[0], body: frame[1] });
    },
  };
});

const base = server({
  upgrade: (request) => requireUsername(request),
  translate: foreignProtocol,
  capabilities: [
    emits({ heard: t<{ text: string; translatorSequence: number }>(), 'outbound-throw': t<{}>() }),
    errors([ForeignError]),
  ],
});

const echo = base.on('echo', {
  input: v.object({ text: v.string(), translatorSequence: v.number() }),
  run(ctx, payload) {
    ctx.send('heard', payload);
  },
});

const outboundThrow = base.on('outbound-throw', {
  input: v.object({}),
  run(ctx) {
    ctx.send('outbound-throw', {});
  },
});

const serverError = base.on('server-error', {
  input: v.strictObject({}),
  run() {
    throw ForeignError({ reason: 'translated error' });
  },
});

export const translationDefinition = base.assemble({
  handlers: [echo, outboundThrow, serverError],
});

const passThrough = translator(() => ({
  inbound: () => null,
  outbound: () => null,
}));

const passThroughBase = server({
  upgrade: (request) => requireUsername(request),
  translate: passThrough,
  capabilities: [emits({ heard: t<{ text: string }>() })],
});

const passThroughEcho = passThroughBase.on('echo', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.send('heard', payload);
  },
});

export const translationPassThroughDefinition = passThroughBase.assemble({
  handlers: [passThroughEcho],
});

const inboundOnly = translator(() => ({
  input: v.object({ type: v.literal('send'), text: v.string() }),
  inbound(frame) {
    return JSON.stringify(['echo', { text: frame.text }, null]);
  },
}));

const inboundOnlyBase = server({
  upgrade: (request) => requireUsername(request),
  translate: inboundOnly,
  capabilities: [emits({ heard: t<{ text: string }>() })],
});

const inboundOnlyEcho = inboundOnlyBase.on('echo', {
  input: v.object({ text: v.string() }),
  run(ctx, payload) {
    ctx.send('heard', payload);
  },
});

export const translationInboundOnlyDefinition = inboundOnlyBase.assemble({
  handlers: [inboundOnlyEcho],
});
