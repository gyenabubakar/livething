/* oxlint-disable @typescript-eslint/no-explicit-any */
import { contract } from '~/_api/contract.ts';
import { t } from '~/_api/definitions.ts';
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
  return contract('app', {
    env: t<Record<string, unknown>>(),
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
        .request('lookup', (ctx) => ctx.respond({}))
        .request('lookup', (ctx) => ctx.respond({})),
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

  it('rejects a second intercept', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .intercept(() => {})
        .intercept(() => {}),
    ).toThrow(/Duplicate intercept/);
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
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [
        incoming('chat', v.object({ text: v.string() })),
        request('lookup', { payload: v.object({}), response: v.object({}) }),
      ],
    });
    const g1 = group(c, (gb) => gb.on('chat', () => {}));
    const g2 = group(c, (gb) => gb.request('lookup', (ctx) => ctx.respond({})));
    expect(() => implement(c).use(g1).use(g2).build()).not.toThrow();
  });
});

describe('GroupBuilder — full method surface', () => {
  it('carries resumableStream + recordedStream + customReplay + lifecycle into the implementer', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        resumableStream('paginate', { payload: v.object({}), chunk: v.object({}) }),
        recordedStream('ai', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    const g = group(c, (gb) =>
      gb
        .resumableStream('paginate', async function* () {})
        .recordedStream('ai', async function* () {})
        .customReplay({ onReplay: () => {} })
        .onConnect(() => {})
        .onDisconnect(() => {}),
    );
    expect(() => implement(c).use(g).build()).not.toThrow();
  });

  it('rejects a group lifecycle hook that the implementer already set', () => {
    const c = makeContract();
    const g = group(c, (gb) => gb.onConnect(() => {}));
    expect(() =>
      implement(c)
        .onConnect(() => {})
        .use(g),
    ).toThrow(/Duplicate .onConnect\(\) from a group/);
  });

  it('rejects a group customReplay that the implementer already set', () => {
    const c = makeContract();
    const g = group(c, (gb) => gb.customReplay({ onReplay: () => {} }));
    expect(() =>
      implement(c)
        .customReplay({ onReplay: () => {} })
        .use(g),
    ).toThrow(/Duplicate \.customReplay\(\) from a group/);
  });

  it('rejects a second .onUpgrade on the implementer', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .onUpgrade(() => ({ identity: 'a' }))
        .onUpgrade(() => ({ identity: 'a' })),
    ).toThrow(/Duplicate .onUpgrade\(\) on the implementer/);
  });

  it('rejects a second .onConnect on the implementer', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .onConnect(() => {})
        .onConnect(() => {}),
    ).toThrow(/Duplicate .onConnect\(\) on the implementer/);
  });

  it('rejects a second .customReplay on the implementer', () => {
    const c = makeContract();
    expect(() =>
      implement(c)
        .customReplay({ onReplay: () => {} })
        .customReplay({ onReplay: () => {} }),
    ).toThrow(/Duplicate .customReplay\(\) on the implementer/);
  });

  it('rejects a second .onSubscribe on a channel sub-builder', () => {
    const c = makeContract();
    expect(() =>
      implement(c).channel('rooms', (ch) => ch.onSubscribe(() => {}).onSubscribe(() => {})),
    ).toThrow(/Duplicate .onSubscribe\(\) on this channel/);
  });

  it('rejects a second .customReplay on a channel sub-builder', () => {
    const c = makeContract();
    expect(() =>
      implement(c).channel('rooms', (ch) =>
        ch.customReplay({ onReplay: () => {} }).customReplay({ onReplay: () => {} }),
      ),
    ).toThrow(/Duplicate .customReplay\(\) on this channel/);
  });

  it('rejects a second .revalidate on a channel sub-builder', () => {
    const c = makeContract();
    expect(() =>
      implement(c).channel('rooms', (ch) => ch.revalidate(() => {}).revalidate(() => {})),
    ).toThrow(/Duplicate .revalidate\(\) on this channel/);
  });

  it('rejects a second .onUpgrade inside one group', () => {
    const c = makeContract();
    expect(() =>
      group(c, (gb) =>
        gb.onUpgrade(() => ({ identity: 'a' })).onUpgrade(() => ({ identity: 'a' })),
      ),
    ).toThrow(/Duplicate \.onUpgrade\(\) on this group/);
  });
});

describe('Implementer — onBinary requires `binary: true`', () => {
  it('throws at build when an onBinary handler is attached but binary is off', () => {
    const c = makeContract(); // no `binary: true`
    expect(() =>
      implement(c)
        .onBinary(() => {})
        .build(),
    ).toThrow(/onBinary handler registered but `binary: true` is not set/);
  });

  it('builds cleanly when the contract enables binary', () => {
    const c = contract('app', { binary: true, definitions: [] });
    expect(() =>
      implement(c)
        .onBinary(() => {})
        .build(),
    ).not.toThrow();
  });
});
