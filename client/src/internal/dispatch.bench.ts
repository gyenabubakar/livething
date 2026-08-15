import { dispatchToHandlers } from '~/internal/dispatch.ts';
import { bench, describe } from 'vitest';
import type { PrimitiveLogger } from '~/internal/runtime.ts';

const log: PrimitiveLogger = {
  debug: false,
  info() {},
  warn() {},
  error() {},
  report() {},
};

function handlerSet(count: number): Set<(payload: unknown) => void> {
  const handlers = new Set<(payload: unknown) => void>();
  let sink = 0;
  for (let i = 0; i < count; i++) handlers.add(() => void sink++);
  return handlers;
}

const payload = { text: 'hello', from: 'u-1' };

// One handler per event is by far the most common shape (a component binding a
// listener), and every inbound frame that reaches a `.on()` handler goes through
// here — so the per-call allocation is what matters, not the handler body.
describe('dispatchToHandlers · 100k fan-outs', () => {
  const one = handlerSet(1);
  const four = handlerSet(4);
  const sixteen = handlerSet(16);

  bench('single handler', () => {
    for (let i = 0; i < 100_000; i++) dispatchToHandlers(one, log, payload);
  });

  bench('four handlers', () => {
    for (let i = 0; i < 100_000; i++) dispatchToHandlers(four, log, payload);
  });

  bench('sixteen handlers', () => {
    for (let i = 0; i < 100_000; i++) dispatchToHandlers(sixteen, log, payload);
  });

  bench('no handler registered', () => {
    for (let i = 0; i < 100_000; i++) dispatchToHandlers(undefined, log, payload);
  });
});
