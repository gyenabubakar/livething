import { define, emits, t, translator } from '@wskit/server';
import { bind } from '@wskit/server-cloudflare';
import { requireUsername } from '@wskit/tests-e2e-handlers/_shared/upgrade';
import {
  translationHandler,
  translationInboundOnlyHandler,
  translationPassThroughHandler,
} from '@wskit/tests-e2e-handlers/translation';
import * as v from 'valibot';

const hibernationForeignProtocol = translator(() => {
  let sequence = 0;

  return {
    inbound(raw) {
      if (raw === 'ping') return raw;

      const frame = v.parse(
        v.object({ type: v.literal('send'), text: v.string() }),
        JSON.parse(raw),
      );
      return JSON.stringify({
        event: 'echo',
        payload: { text: frame.text, translatorSequence: ++sequence },
      });
    },
    outbound(outgoing) {
      if (outgoing === 'pong') return 'foreign-pong';

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

const translationHibernationHandler = hibernationBase.assemble({
  handlers: [hibernationEcho],
});

export class TranslationServer extends bind(translationHandler) {}

export class TranslationPassThroughServer extends bind(translationPassThroughHandler) {}

export class TranslationInboundOnlyServer extends bind(translationInboundOnlyHandler) {}

export class TranslationHibernationServer extends bind(translationHibernationHandler) {}
