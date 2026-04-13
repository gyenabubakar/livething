import { Forbidden, NotFound } from '../errors.ts';
import { base } from '../setup.ts';
import { Echo, TriggerError } from './events.ts';

export const echoHandlers = base
  .group()
  .incoming(Echo, (ctx, payload) => {
    ctx.send('echoed', { text: payload.text, from: ctx.meta.username, ts: Date.now() });
    ctx.ack();
  })
  .incoming(TriggerError, (_ctx, payload) => {
    if (payload.code === 'not-found') throw NotFound({ id: 'test-123' });
    throw Forbidden({ reason: 'Access denied' });
  })
  .extract();
