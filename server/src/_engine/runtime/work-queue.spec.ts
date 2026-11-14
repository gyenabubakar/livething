import { ConnectionBusy } from '@livething/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PENDING_CONNECTION_WORK, runConnectionWork } from './work-queue.ts';
import type { RuntimeConnection } from './types.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function connection(): Pick<RuntimeConnection, 'workQueue'> {
  return {};
}

describe('runConnectionWork', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('limits admitted unfinished ordered work per connection', async () => {
    const current = connection();
    const release = deferred();
    const work = vi.fn(async (index: number) => {
      if (index === 0) await release.promise;
    });

    const admitted = Array.from({ length: MAX_PENDING_CONNECTION_WORK }, (_, index) =>
      runConnectionWork(current, false, () => work(index)),
    );

    expect(current.workQueue?.pending).toBe(MAX_PENDING_CONNECTION_WORK);
    await expect(
      runConnectionWork(current, false, () => work(MAX_PENDING_CONNECTION_WORK)),
    ).rejects.toSatisfy((error: unknown) => ConnectionBusy.matches(error));

    release.resolve();
    await Promise.all(admitted);

    expect(work).toHaveBeenCalledTimes(MAX_PENDING_CONNECTION_WORK);
    expect(current.workQueue?.pending).toBe(0);
  });

  it('does not create or use the queue for interleaved work', async () => {
    const current = connection();
    const work = vi.fn();

    await runConnectionWork(current, true, work);

    expect(work).toHaveBeenCalledOnce();
    expect(current.workQueue).toBeUndefined();
  });

  it('runs work queued from inside running work after that work ends', async () => {
    const current = connection();
    const release = deferred();
    const order: string[] = [];
    let inner: Promise<void> | undefined;

    const outer = runConnectionWork(current, false, async () => {
      order.push('outer start');
      inner = runConnectionWork(current, false, () => {
        order.push('inner');
      });
      await release.promise;
      order.push('outer end');
    });

    await Promise.resolve();
    expect(order).toEqual(['outer start']);

    release.resolve();
    await outer;
    await inner;

    expect(order).toEqual(['outer start', 'outer end', 'inner']);
    expect(current.workQueue?.pending).toBe(0);
  });

  it('runs work queued from inside synchronous work after it, not inside it', async () => {
    const current = connection();
    const order: string[] = [];
    let inner: Promise<void> | undefined;

    const outer = runConnectionWork(current, false, () => {
      inner = runConnectionWork(current, false, () => {
        order.push('inner');
      });
      order.push('outer');
    });
    await outer;
    await inner;

    expect(order).toEqual(['outer', 'inner']);
  });

  it('keeps later work behind work that started at once and is still running', async () => {
    const current = connection();
    const release = deferred();
    const order: string[] = [];

    const first = runConnectionWork(current, false, async () => {
      await release.promise;
      order.push('first');
    });
    const second = runConnectionWork(current, false, () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual([]);

    release.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('turns a synchronous throw into a rejection and frees the line', async () => {
    const current = connection();
    const failure = new Error('handler threw');

    await expect(
      runConnectionWork(current, false, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(current.workQueue?.pending).toBe(0);

    await expect(runConnectionWork(current, false, () => 'next')).resolves.toBe('next');
  });

  it('releases an admission slot when ordered work rejects', async () => {
    const current = connection();
    const failure = new Error('failed work');

    await expect(runConnectionWork(current, false, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(current.workQueue?.pending).toBe(0);
  });
});
