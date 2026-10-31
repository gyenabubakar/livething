import { isLiveThingConfigError } from '@livething/core';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('nothing was thrown');
}

describe('a definition mistake throws a LiveThingConfigError', () => {
  it('on a bad channel membership value', () => {
    const base = server({ capabilities: [channels()] });

    const error = thrownBy(() => base.channel('room', { membership: 'persistant' as never }));

    expect(isLiveThingConfigError(error)).toBe(true);
    expect(String((error as Error).message)).toMatch(/^\[livething\] [^[]/);
  });

  it('on one channel event passed twice', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {});
    const first = room.on('say', { input: v.object({}), run() {} });
    const second = room.on('say', { input: v.object({}), run() {} });

    expect(
      isLiveThingConfigError(thrownBy(() => base.assemble({ handlers: [first, second] as never }))),
    ).toBe(true);
  });

  it('on a bad plugin id', () => {
    const polls = server({ scope: 'plugin' }).assemble({ handlers: [] });

    expect(
      isLiveThingConfigError(thrownBy(() => plugin('Bad Id', { definition: polls } as never))),
    ).toBe(true);
  });

  it('on a reserved event name at compile', () => {
    const base = server({});
    const definition = base.assemble({
      handlers: [base.on('a::b', { input: v.object({}), run() {} })],
    });

    const error = thrownBy(() => compileServerDefinition(definition));

    expect(isLiveThingConfigError(error)).toBe(true);
    expect((error as Error).message).toMatch(/^\[livething\] [^[]/);
  });
});

it('a missing users.onExceed throws', () => {
  const base = server({ users: { maxConnections: 2 } as never });

  expect(isLiveThingConfigError(thrownBy(() => base.assemble({ handlers: [] })))).toBe(true);
});
