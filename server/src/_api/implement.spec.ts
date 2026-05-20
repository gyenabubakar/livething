/* oxlint-disable @typescript-eslint/no-explicit-any */
import { contract } from '~/_api/contract.ts';
import { group, implement } from '~/_api/implement.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import { request } from '~/request/definition.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { stream } from '~/stream/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

function makeContract() {
  return contract<Record<string, unknown>>('app')({
    persistence: true,
    definitions: [
      incoming('chat', v.object({ text: v.string() })),
      request('lookup', { payload: v.object({}), response: v.object({}) }),
      stream('feed', { payload: v.object({}), chunk: v.object({}) }),
      resumableStream('paginate', { payload: v.object({}), chunk: v.object({}) }),
      recordedStream('ai', { payload: v.object({}), chunk: v.object({}) }),
      channel('rooms', {
        definitions: [
          incoming('send', v.object({ text: v.string() })),
          stream('history', { payload: v.object({}), chunk: v.object({}) }),
        ],
      }),
      namespace('admin', {
        definitions: [incoming('kick', v.object({ id: v.string() }))],
      }),
    ],
  });
}

describe('Implementer — duplicate-handler detection', () => {
  it('rejects a second .on for the same event', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .on('chat', () => {})
        .on('chat', () => {}),
    ).toThrow(/Duplicate incoming handler for 'chat' in the implementer/);
  });

  it('rejects a second .request for the same event', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .request('lookup', () => ({}))
        .request('lookup', () => ({})),
    ).toThrow(/Duplicate request handler for 'lookup'/);
  });

  it('rejects a second .stream for the same event', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .stream('feed', async function* () {})
        .stream('feed', async function* () {}),
    ).toThrow(/Duplicate stream handler for 'feed'/);
  });

  it('rejects a second .resumableStream for the same event', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .resumableStream('paginate', async function* () {})
        .resumableStream('paginate', async function* () {}),
    ).toThrow(/Duplicate resumableStream handler for 'paginate'/);
  });

  it('rejects a second .recordedStream for the same event', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .recordedStream('ai', async function* () {})
        .recordedStream('ai', async function* () {}),
    ).toThrow(/Duplicate recordedStream handler for 'ai'/);
  });

  it('rejects a second .channel for the same channel name', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .channel('rooms', () => {})
        .channel('rooms', () => {}),
    ).toThrow(/Duplicate channel handler for 'rooms'/);
  });

  it('rejects a second .namespace for the same namespace name', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .namespace('admin', () => {})
        .namespace('admin', () => {}),
    ).toThrow(/Duplicate namespace handler for 'admin'/);
  });

  it('rejects a second pre-intercept', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .intercept(() => {})
        .intercept(() => {}),
    ).toThrow(/Duplicate pre-intercept/);
  });

  it('rejects a second post-intercept for the same event', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .intercept('chat', () => {})
        .intercept('chat', () => {}),
    ).toThrow(/Duplicate post-intercept handler for 'chat'/);
  });

  it('rejects a duplicate handler inside a channel sub-builder', () => {
    const c = makeContract();
    expect(() =>
      implement(c).channel('rooms', (ch) => ch.on('send', () => {}).on('send', () => {})),
    ).toThrow(/Duplicate incoming handler for 'send' in this channel/);
  });

  it('rejects a duplicate handler inside a namespace sub-builder', () => {
    const c = makeContract();
    expect(() =>
      implement(c).namespace('admin', (ns) => ns.on('kick', () => {}).on('kick', () => {})),
    ).toThrow(/Duplicate incoming handler for 'kick' in this namespace/);
  });
});

describe('GroupBuilder — duplicate-handler detection', () => {
  it('rejects a second .on inside one group', () => {
    const c = makeContract();
    expect(() => group(c, (g) => g.on('chat', () => {}).on('chat', () => {}))).toThrow(
      /Duplicate incoming handler for 'chat' in this group/,
    );
  });

  it('rejects a second .stream inside one group', () => {
    const c = makeContract();
    expect(() =>
      group(c, (g) =>
        g.stream('feed', async function* () {}).stream('feed', async function* () {}),
      ),
    ).toThrow(/Duplicate stream handler for 'feed' in this group/);
  });
});

describe('Implementer.use(group) — duplicate detection across boundaries', () => {
  it('rejects a group whose handler collides with the implementer', () => {
    const c = makeContract();
    const g = group(c, (gb) => gb.on('chat', () => {}));
    expect(() =>
      implement(c)
        .on('chat', () => {})
        .use(g),
    ).toThrow(/Duplicate incoming handler for 'chat' in a group/);
  });

  it('rejects two groups that share a handler', () => {
    const c = makeContract();
    const g1 = group(c, (gb) => gb.on('chat', () => {}));
    const g2 = group(c, (gb) => gb.on('chat', () => {}));
    expect(() => implement(c).use(g1).use(g2)).toThrow(
      /Duplicate incoming handler for 'chat' in a group/,
    );
  });

  it('allows two groups whose handlers do not overlap', () => {
    const c = contract<Record<string, unknown>>('app')({
      definitions: [
        incoming('chat', v.object({ text: v.string() })),
        request('lookup', { payload: v.object({}), response: v.object({}) }),
      ],
    });
    const g1 = group(c, (gb) => gb.on('chat', () => {}));
    const g2 = group(c, (gb) => gb.request('lookup', () => ({})));
    expect(() => implement(c).use(g1).use(g2).build()).not.toThrow();
  });
});
