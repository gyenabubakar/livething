/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WIRE_LIMITS } from '@wskit/core';
import { contract } from '~/_api/contract.ts';
import { t } from '~/_api/definitions.ts';
import { implement } from '~/_api/implement.ts';
import { scope } from '~/channel/channel.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { plugin } from '~/plugins/plugin.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { nudge, stream } from '~/stream/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { compileHandlerDefinition } from './compile.ts';

describe('boot-time cross-primitive collision guard', () => {
  it('rejects the same event used as both stream and resumableStream at top level', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        stream('feed', { payload: v.object({}), chunk: v.object({}) }),
        resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .stream('feed', async function* () {
            yield {};
          })
          .resumableStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'feed' is registered as both 'stream' and 'resumableStream'/);
  });

  it('rejects the same event used as both resumableStream and recordedStream', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
        recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .resumableStream('feed', async function* () {
            yield {};
          })
          .recordedStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'feed' is registered as both 'resumableStream' and 'recordedStream'/);
  });

  it('rejects the same event used as incoming + recordedStream', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        incoming('feed', v.object({})),
        recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .on('feed', () => {})
          .recordedStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'feed' is registered as both 'incoming' and 'recordedStream'/);
  });

  it('rejects the collision inside a channel scope', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        channel('rooms', {
          definitions: [
            stream('feed', { payload: v.object({}), chunk: v.object({}) }),
            recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
          ],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('rooms', (ch) =>
            ch
              .stream('feed', async function* () {
                yield {};
              })
              .recordedStream('feed', async function* () {
                yield {};
              }),
          )
          .build(),
      ),
    ).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'recordedStream' in channel 'rooms'/,
    );
  });

  it('rejects the collision inside a channel-family scope', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        channel(scope('rooms', 'room:{id}'), {
          definitions: [
            stream('feed', { payload: v.object({}), chunk: v.object({}) }),
            resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
          ],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('rooms', (ch) =>
            ch
              .stream('feed', async function* () {
                yield {};
              })
              .resumableStream('feed', async function* () {
                yield {};
              }),
          )
          .build(),
      ),
    ).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'resumableStream' in channel family 'rooms'/,
    );
  });

  it('allows the same event in different scopes', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        stream('feed', { payload: v.object({}), chunk: v.object({}) }),
        channel('rooms', {
          definitions: [recordedStream('feed', { payload: v.object({}), chunk: v.object({}) })],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .stream('feed', async function* () {
            yield {};
          })
          .channel('rooms', (ch) =>
            ch.recordedStream('feed', async function* () {
              yield {};
            }),
          )
          .build(),
      ),
    ).not.toThrow();
  });
});

describe('scope and event name syntax — reserved characters', () => {
  it('rejects a channel name starting with @', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel('@chat', { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /channel name '@chat' starts with a reserved prefix character/,
    );
  });

  it('rejects a channel name starting with #', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel('#chat', { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /channel name '#chat' starts with a reserved prefix character/,
    );
  });

  it('rejects a channel name containing ::', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel('chat::rooms', { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /channel name 'chat::rooms' contains '::'/,
    );
  });

  it('rejects a channel family key starting with @', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel(scope('@rooms', 'room:{id}'), { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /channel name '@rooms' starts with a reserved prefix character/,
    );
  });

  it('rejects a top-level event name containing ::', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [incoming('send::message', v.object({}))],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .on('send::message', () => {})
          .build(),
      ),
    ).toThrow(/Event name 'send::message' in top-level contains '::'/);
  });

  it('rejects a declared event name longer than the wire limit', () => {
    const tooLong = 'e'.repeat(WIRE_LIMITS.event + 1);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [incoming(tooLong, v.object({}))],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .on(tooLong, () => {})
          .build(),
      ),
    ).toThrow(/the wire protocol limit\s+is 128/);
  });

  it('rejects a declared channel name longer than the wire limit', () => {
    const tooLong = 'c'.repeat(WIRE_LIMITS.channel + 1);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel(tooLong, { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /channel name is \d+ characters; the wire protocol limit is 256/,
    );
  });

  it('rejects an event name containing :: inside a channel', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel('chat', { definitions: [incoming('send::message', v.object({}))] })],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('chat', (ch) => ch.on('send::message', () => {}))
          .build(),
      ),
    ).toThrow(/Event name 'send::message' in channel 'chat' contains '::'/);
  });

  it('rejects a stream event name containing ::', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [stream('count::up', { payload: v.object({}), chunk: v.object({}) })],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .stream('count::up', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'count::up' in top-level contains '::'/);
  });

  it('allows ordinary names with @, #, and : at non-start positions', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [
        channel('chat@v1', { definitions: [] }),
        incoming('user:created', v.object({})),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .on('user:created', () => {})
          .build(),
      ),
    ).not.toThrow();
  });

  it('allows a dynamic family key at the channelScope wire limit', () => {
    const key = 'k'.repeat(WIRE_LIMITS.channelScope);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel(scope(key, 'room:{id}'), { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).not.toThrow();
  });

  it('rejects a dynamic family key one over the channelScope wire limit', () => {
    const key = 'k'.repeat(WIRE_LIMITS.channelScope + 1);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel(scope(key, 'room:{id}'), { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /channel name is \d+ characters; the wire protocol limit is 128/,
    );
  });

  it('allows a static channel name up to the larger channel wire limit', () => {
    const name = 'c'.repeat(WIRE_LIMITS.channel);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [channel(name, { definitions: [] })],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).not.toThrow();
  });

  it('rejects an ephemeral stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [
        stream('feed', {
          payload: v.object({}),
          chunk: v.object({}),
          nudges: [nudge(tooLong, v.object({}))],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .stream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/the wire protocol limit\s+is 128/);
  });

  it('rejects a resumable stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        resumableStream('feed', {
          payload: v.object({}),
          chunk: v.object({}),
          nudges: [nudge(tooLong, v.object({}))],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .resumableStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/the wire protocol limit\s+is 128/);
  });

  it('rejects a recorded stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      definitions: [
        recordedStream('feed', {
          payload: v.object({}),
          chunk: v.object({}),
          maxChunks: 10,
          nudges: [nudge(tooLong, v.object({}))],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .recordedStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/the wire protocol limit\s+is 128/);
  });
});

describe('boot-time same-kind duplicate guard', () => {
  // Pre-fix every `.set()` in compile silently overwrote on duplicate keys.
  // A refactor that pasted an incoming("same", ...) twice, or two channel
  // definitions with the same name, just kept the last one with no error.
  // Each test below configures a duplicate and asserts compile refuses to
  // produce a CompiledServer — the engine never gets a chance to construct,
  // so the server refuses to start.

  it('rejects two incoming declarations with the same event name at top level', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [incoming('same', v.object({})), incoming('same', v.object({}))],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .on('same', () => {})
          .build(),
      ),
    ).toThrow(/Duplicate incoming declaration for "same"/);
  });

  it('rejects two channel declarations with the same name', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [
        channel('room', { definitions: [incoming('msg', v.object({}))] }),
        channel('room', { definitions: [incoming('msg2', v.object({}))] }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('room', (ch) => ch.on('msg', () => {}).on('msg2', () => {}))
          .build(),
      ),
    ).toThrow(/Duplicate channel declaration for "room"/);
  });

  it('rejects a plugin whose dependencies are not enabled on the contract', () => {
    // Pre-fix the dependencies array was attached to the factory function but
    // never validated. A plugin declaring dependencies: ['persistence'] would
    // happily install on a contract with no persistence, then crash later
    // inside setup() with a stack trace that points away from the misconfig.
    const NeedsPersistence = plugin('acme:needs-persistence', {
      dependencies: ['persistence'],
      setup: () => () => ({}),
    });
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      plugins: [NeedsPersistence()],
      definitions: [],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /Plugin "acme:needs-persistence" declares a dependency on "persistence"/,
    );
  });

  it('accepts a plugin whose dependencies are all enabled', () => {
    const NeedsPersistence = plugin('acme:needs-persistence-ok', {
      dependencies: ['persistence'],
      setup: () => () => ({}),
    });
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      persistence: true,
      plugins: [NeedsPersistence()],
      definitions: [],
    });
    expect(() => compileHandlerDefinition(implement(c).build())).not.toThrow();
  });

  it('rejects replay:false for a plugin that depends on replay', () => {
    const NeedsReplay = plugin('acme:needs-replay', {
      dependencies: ['replay'],
      setup: () => () => ({}),
    });
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      replay: false,
      plugins: [NeedsReplay()],
      definitions: [],
    });

    expect(() => compileHandlerDefinition(implement(c).build())).toThrow(
      /Plugin "acme:needs-replay" declares a dependency on "replay"/,
    );
  });

  it('rejects two incoming declarations with the same event name inside a channel scope', () => {
    const c = contract('app', {
      env: t<Record<string, unknown>>(),
      definitions: [
        channel('room', {
          definitions: [incoming('msg', v.object({})), incoming('msg', v.object({}))],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('room', (ch) => ch.on('msg', () => {}))
          .build(),
      ),
    ).toThrow(/Duplicate incoming in channel "room" declaration for "msg"/);
  });
});
