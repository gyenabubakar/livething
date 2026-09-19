import { emits, server, t, translator } from '@livething/server';
import { bind } from '@livething/server-cloudflare';
import { requireUsername } from '@livething/tests-e2e-handlers/_shared/upgrade';
import {
  translationDefinition,
  translationInboundOnlyDefinition,
  translationPassThroughDefinition,
} from '@livething/tests-e2e-handlers/translation';
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
      return JSON.stringify(['echo', { text: frame.text, translatorSequence: ++sequence }, null]);
    },
    outbound(outgoing) {
      if (outgoing === 'pong') return 'foreign-pong';

      const frame = JSON.parse(outgoing) as [string, unknown, unknown];
      return JSON.stringify({ type: 'message', name: frame[0], body: frame[1] });
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

const hibernationBase = server({
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

const translationHibernationDefinition = hibernationBase.assemble({
  handlers: [hibernationEcho],
});

export class TranslationServer extends bind(translationDefinition) {}

export class TranslationPassThroughServer extends bind(translationPassThroughDefinition) {}

export class TranslationInboundOnlyServer extends bind(translationInboundOnlyDefinition) {}

export class TranslationHibernationServer extends bind(translationHibernationDefinition) {}
