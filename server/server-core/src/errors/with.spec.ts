import { server } from '~/_builder/server-builder.ts';
import { error } from '~/errors/errors.ts';
import { withErrors } from '~/errors/with.ts';
import { event } from '~/event.ts';
import { describe, expect, it } from 'vitest';

const message = event('message', (p: unknown) => p as { text: string });
const sendMessage = event('send-message', (p: unknown) => p as { text: string });

const Forbidden = error('forbidden', (p: unknown) => p as { reason: string });
const QuotaExceeded = error('quota-exceeded', (p: unknown) => p as { limit: number });

describe('.errors() side-effect', () => {
  it('adds errors primitive', () => {
    const def = withErrors(server('chat')).errors(Forbidden, QuotaExceeded).build();

    expect(def.primitives).toHaveLength(1);
    expect(def.primitives[0]!.__wskit).toBe('errors');
  });

  it('rejects duplicate errors registration', () => {
    expect(() =>
      withErrors(server('chat')).errors(Forbidden).errors(QuotaExceeded).build(),
    ).toThrow(/Duplicate registration/);
  });

  it('chains with other primitives', () => {
    const def = withErrors(server('chat'))
      .errors(Forbidden, QuotaExceeded)
      .outgoing(message)
      .incoming(sendMessage, async () => {})
      .build();

    expect(def.primitives).toHaveLength(3);
    expect(def.primitives[0]!.__wskit).toBe('errors');
    expect(def.primitives[1]!.__wskit).toBe('outgoing');
    expect(def.primitives[2]!.__wskit).toBe('incoming');
  });

  it('works with GroupBuilder', () => {
    const base = withErrors(server('chat')).outgoing(message);
    const def = base.use(base.group((g) => g.errors(Forbidden))).build();

    expect(def.primitives.some((p) => p.__wskit === 'errors')).toBe(true);
  });
});
