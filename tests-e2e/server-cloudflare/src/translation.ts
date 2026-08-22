import { define, emits, errors, t, translator } from '@wskit/server';
import { server } from '@wskit/server-cloudflare';
import { error } from '@wskit/server/errors';
import { requireUsername } from '@wskit/tests-e2e-handlers/_shared/upgrade';
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
        return JSON.stringify({
          event: 'echo',
          payload: { text: body.text, translatorSequence: ++sequence },
        });
      }
      return JSON.stringify({ event: frame.name, payload: {} });
    },
    outbound(outgoing) {
      const frame = JSON.parse(outgoing) as { event: string; payload: unknown };
      if (frame.event === 'outbound-throw') throw new Error('outbound failure');
      return JSON.stringify({ type: 'message', name: frame.event, body: frame.payload });
    },
  };
});

const base = define({
  env: t<Env>(),
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

const translationHandler = base.assemble({ handlers: [echo, outboundThrow, serverError] });

const passThrough = translator(() => ({
  inbound: () => null,
  outbound: () => null,
}));

const passThroughBase = define({
  env: t<Env>(),
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

const passThroughHandler = passThroughBase.assemble({ handlers: [passThroughEcho] });

const inboundOnly = translator(() => ({
  input: v.object({ type: v.literal('send'), text: v.string() }),
  inbound(frame) {
    return JSON.stringify({ event: 'echo', payload: { text: frame.text } });
  },
}));

const inboundOnlyBase = define({
  env: t<Env>(),
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

const inboundOnlyHandler = inboundOnlyBase.assemble({ handlers: [inboundOnlyEcho] });

const hibernationForeignProtocol = translator(() => {
  let sequence = 0;

  return {
    input: v.object({ type: v.literal('send'), text: v.string() }),
    inbound(frame) {
      return JSON.stringify({
        event: 'echo',
        payload: { text: frame.text, translatorSequence: ++sequence },
      });
    },
    outbound(outgoing) {
      const frame = JSON.parse(outgoing) as { event: string; payload: unknown };
      return JSON.stringify({ type: 'message', name: frame.event, body: frame.payload });
    },
    hibernation: {
      serialize() {
        return { sequence };
      },
      restore(state) {
        sequence = state?.sequence ?? 0;
      },
    },
  };
});

const hibernationBase = define({
  env: t<Env>(),
  hibernation: { enabled: true },
  upgrade: (request) => requireUsername(request),
  translate: hibernationForeignProtocol,
  capabilities: [emits({ heard: t<{ text: string; translatorSequence: number }>() })],
});

const hibernationEcho = hibernationBase.on('echo', {
  input: v.object({ text: v.string(), translatorSequence: v.number() }),
  run(ctx, payload) {
    ctx.send('heard', payload);
  },
});

const translationHibernationHandler = hibernationBase.assemble({ handlers: [hibernationEcho] });

export class TranslationServer extends server(translationHandler) {}
export class TranslationPassThroughServer extends server(passThroughHandler) {}
export class TranslationInboundOnlyServer extends server(inboundOnlyHandler) {}
export class TranslationHibernationServer extends server(translationHibernationHandler) {}
