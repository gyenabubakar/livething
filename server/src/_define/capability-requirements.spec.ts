/* oxlint-disable @typescript-eslint/no-explicit-any */
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { t } from '~/index.ts';
import { persistence } from '~/persistence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it } from 'vitest';

// Locks the resolver's recursion into channels and its conditional (persistent
// tags) requirement — the headline behavior of the capability-requirement model.
// A regression that stopped recursing into channels, or stopped treating
// persistent tags as needing persistence, would otherwise pass the suite.
describe('capability requirements — channel-nested + conditional', () => {
  it('a channel-nested recordedStream without persistence is a build error', () => {
    const base = define({ env: t<object>(), capabilities: [channels(), recordedStream()] });
    const rooms = base.channel('rooms', {});
    const h = rooms.recordedStream('paginate', { async *run() {} } as any);
    expect(() => base.assemble({ handlers: [h] })).toThrow(/persistence/);
  });

  it('a channel-nested resumableStream without persistence is a build error', () => {
    const base = define({ env: t<object>(), capabilities: [channels(), resumableStream()] });
    const rooms = base.channel('rooms', {});
    const h = rooms.resumableStream('paginate', { async *run() {} } as any);
    expect(() => base.assemble({ handlers: [h] })).toThrow(/persistence/);
  });

  it('persistent tag groups need persistence; ephemeral-only does not', () => {
    const persistent = define({
      env: t<object>(),
      capabilities: [tags((_e, p) => [p('favorite', t<string>())])],
    });
    expect(() => persistent.assemble({ handlers: [] })).toThrow(/persistence/);

    const ephemeral = define({
      env: t<object>(),
      capabilities: [tags((e) => [e('role', t<string>())])],
    });
    expect(() => ephemeral.assemble({ handlers: [] })).not.toThrow();
  });

  it('listing persistence() satisfies a channel-nested durable stream', () => {
    const base = define({
      env: t<object>(),
      capabilities: [persistence(), channels(), recordedStream()],
    });
    const rooms = base.channel('rooms', {});
    const h = rooms.recordedStream('paginate', { async *run() {} } as any);
    expect(() => base.assemble({ handlers: [h] })).not.toThrow();
  });
});
