/**
 * `initialize()` has call sites an adapter does not serialize on its own: its
 * own boot call, and the one inside `handleAlarm`. Cloudflare hides the overlap
 * behind `blockConcurrencyWhile`, so these guard the adapters that have no such
 * queue.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function buildEngine(handler: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const server = adapter({
    id: 'initialize-once',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        env: {},
        platform: {},
        timers: createTestTimers(),
        waitUntil: () => {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  server(handler, undefined as never);
  if (!captured) throw new Error('engine not captured');
  return captured;
}

function assembleWith(
  base: ReturnType<typeof define<Record<string, never>, unknown, readonly []>>,
): ServerDefinition {
  return base.assemble({ handlers: [base.on('noop', { input: v.object({}), run() {} })] });
}

interface GatedEngine {
  engine: Engine;
  /** Resolves once the init hook is running, so a second caller is provably mid-run. */
  hookEntered: Promise<void>;
  /** Lets the init hook finish. */
  release(): void;
  callCount(): number;
}

/**
 * An engine whose init hook parks until released. Holding the run open with a
 * gate rather than a sleep keeps "the second caller arrives mid-run" true no
 * matter how loaded the machine is.
 */
function buildGatedEngine(): GatedEngine {
  let calls = 0;
  let entered!: () => void;
  let release!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const base = define({ env: t<Record<string, never>>(), capabilities: [] });
  base.onInit(async () => {
    calls += 1;
    entered();
    await gate;
  });

  return {
    engine: buildEngine(assembleWith(base)),
    hookEntered,
    release,
    callCount: () => calls,
  };
}

describe('engine.initialize() under concurrent callers', () => {
  it('runs init hooks once when two callers start together', async () => {
    const { engine, release, callCount } = buildGatedEngine();

    const both = Promise.all([engine.initialize(), engine.initialize()]);
    release();
    await both;

    expect(callCount()).toBe(1);
  });

  it('runs init hooks once when the second caller arrives mid-run', async () => {
    const { engine, hookEntered, release, callCount } = buildGatedEngine();

    const first = engine.initialize();
    await hookEntered;
    const second = engine.initialize();
    release();
    await Promise.all([first, second]);

    expect(callCount()).toBe(1);
  });

  it('runs init hooks once when an alarm fires while boot is still running', async () => {
    const { engine, hookEntered, release, callCount } = buildGatedEngine();

    const boot = engine.initialize();
    await hookEntered;
    const alarm = engine.handleAlarm();
    release();
    await Promise.all([boot, alarm]);

    expect(callCount()).toBe(1);
  });

  it('runs init hooks once when an init hook calls initialize() again', async () => {
    let calls = 0;
    let engine!: Engine;

    const base = define({ env: t<Record<string, never>>(), capabilities: [] });
    base.onInit(() => {
      calls += 1;
      // Re-entry from the hook's synchronous body, the earliest point any
      // handler code can run. Not awaited — the run it joins is this one.
      if (calls === 1) void engine.initialize();
    });

    engine = buildEngine(assembleWith(base));
    await engine.initialize();

    expect(calls).toBe(1);
  });

  it('keeps a failed run failed rather than half-installing hooks twice', async () => {
    let calls = 0;

    const base = define({ env: t<Record<string, never>>(), capabilities: [] });
    base.onInit(async () => {
      calls += 1;
      await Promise.resolve();
      throw new Error('boom');
    });
    const engine = buildEngine(assembleWith(base));

    await expect(engine.initialize()).rejects.toThrow('boom');
    await expect(engine.initialize()).rejects.toThrow('boom');

    expect(calls).toBe(1);
  });
});
