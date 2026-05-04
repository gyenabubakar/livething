/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_builder/server-builder.ts';
import { Engine } from '~/_engine/engine.ts';
import { withChannels } from '~/channel/with.ts';
import { withDedup } from '~/dedup/with.ts';
import { event } from '~/event.ts';
import { withReplay } from '~/replay/with.ts';
import { withSequence } from '~/sequence/with.ts';
import { describe, expect, it, vi } from 'vitest';

function fakeStorage() {
  function exec() {
    return { toArray: () => [], one: () => null, raw: () => [] };
  }
  return {
    sql: { exec, transaction: <T>(fn: (tx: any) => T) => fn({ exec }) },
    kv: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
  };
}

function setupEngine(def: any) {
  const engine = new Engine(def, { adapterId: 'test' });
  engine.setStorage(fakeStorage() as any);
  engine.setTimerProvider({ setTimeout: () => 0, clearTimeout: () => {} } as any);
  engine.setEnv({});
  engine.setPlatform({});
  engine.setWaitUntil(() => {});
  return engine;
}

describe('ctx.sendReplay public-API contract', () => {
  const declared = event('declared', (p: unknown) => p as { text: string });
  const subscribe = event('go', (p: unknown) => p as {});

  it('top-level ctx.sendReplay rejects an undeclared event', async () => {
    const captured: Array<{ rejected: boolean; message: string }> = [];

    const def = withReplay(withDedup(withSequence(server('app'))))
      .sequence({ persist: true })
      .dedup()
      .replay((r: any) => r)
      .outgoing(declared)
      .incoming(subscribe, (ctx: any) => {
        try {
          ctx.sendReplay('not-declared', { ok: true }, { seq: 1, messageId: 'm1' });
          captured.push({ rejected: false, message: '' });
        } catch (err) {
          captured.push({
            rejected: true,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .build();

    const engine = setupEngine(def);
    await engine.initialize();
    const handle = engine.accept(Symbol('ws'), {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });
    await handle.handleMessage(JSON.stringify({ event: 'go', payload: {} }));

    expect(captured).toEqual([
      { rejected: true, message: expect.stringMatching(/not declared in the active scope/) },
    ]);
  });

  it('top-level ctx.sendReplay rejects user payload fields starting with "_"', async () => {
    const captured: Array<{ rejected: boolean; message: string }> = [];

    const def = withReplay(withDedup(withSequence(server('app'))))
      .sequence({ persist: true })
      .dedup()
      .replay((r: any) => r)
      .outgoing(declared)
      .incoming(subscribe, (ctx: any) => {
        try {
          ctx.sendReplay('declared', { text: 'hi', _evil: 'leaked' }, { seq: 1, messageId: 'm1' });
          captured.push({ rejected: false, message: '' });
        } catch (err) {
          captured.push({
            rejected: true,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .build();

    const engine = setupEngine(def);
    await engine.initialize();
    const handle = engine.accept(Symbol('ws'), {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });
    await handle.handleMessage(JSON.stringify({ event: 'go', payload: {} }));

    expect(captured).toEqual([
      { rejected: true, message: expect.stringMatching(/reserved for the engine/) },
    ]);
  });

  it('channel ctx.channel.sendReplay rejects an undeclared event in that channel', async () => {
    const captured: Array<{ rejected: boolean; message: string }> = [];
    const lobbyDeclared = event('lobby-msg', (p: unknown) => p as { text: string });
    const trigger = event('trigger', (p: unknown) => p as {});

    const base = withChannels(withReplay(withDedup(withSequence(server('app')))))
      .sequence({ persist: true })
      .dedup();

    const def = base
      .use(
        base.channel('lobby', (ch: any) =>
          ch
            .outgoing(lobbyDeclared)
            .replay((r: any) => r)
            .incoming(trigger, (ctx: any) => {
              try {
                ctx.channel.sendReplay('not-declared', { text: 'x' }, { seq: 1, messageId: 'm1' });
                captured.push({ rejected: false, message: '' });
              } catch (err) {
                captured.push({
                  rejected: true,
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            }),
        ),
      )
      .build();

    const engine = setupEngine(def);
    await engine.initialize();
    const handle = engine.accept(Symbol('ws'), {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });
    await handle.handleMessage(
      JSON.stringify({ event: '_subscribe', payload: { _channel: 'lobby' } }),
    );
    await handle.handleMessage(
      JSON.stringify({ event: 'trigger', payload: { _channel: 'lobby' } }),
    );

    expect(captured).toEqual([
      { rejected: true, message: expect.stringMatching(/not declared in the active scope/) },
    ]);
  });
});
