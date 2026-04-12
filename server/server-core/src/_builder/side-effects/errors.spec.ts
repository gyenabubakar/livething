import { server } from '~/_builder/server-builder.ts';
import { error } from '~/errors/errors.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

import '~/_builder/side-effects/errors.ts';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

const Forbidden = error('forbidden', (p: unknown) => p as { reason: string });
const QuotaExceeded = error('quota-exceeded', (p: unknown) => p as { limit: number });

describe('.errors() side-effect', () => {
  it('adds errors primitive', () => {
    const def = server('chat').errors(Forbidden, QuotaExceeded).done();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('errors');
  });

  it('rejects duplicate errors registration', () => {
    expect(() => server('chat').errors(Forbidden).errors(QuotaExceeded).done()).toThrow(
      /Duplicate registration/,
    );
  });

  it('chains with other primitives', () => {
    const def = server('chat')
      .errors(Forbidden, QuotaExceeded)
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .done();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[0]!.__wskit).toBe('errors');
    expect(def.primitives[1]!.__wskit).toBe('outgoing');
    expect(def.primitives[2]!.__wskit).toBe('incoming');
  });

  it('works with GroupBuilder', () => {
    const base = server('chat').outgoing(message);
    const group = base.group().errors(Forbidden).extract();
    const def = base.use(group).done();

    expect(def.primitives.some((p) => p.__wskit === 'errors')).toBe(true);
  });
});
