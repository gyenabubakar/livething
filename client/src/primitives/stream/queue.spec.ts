import { StreamQueue } from '~/primitives/stream/queue.ts';
import { describe, expect, it } from 'vitest';

describe('StreamQueue', () => {
  describe('push while next() is already awaiting', () => {
    it('hands the chunk directly to the waiting resolver without buffering', async () => {
      const queue = new StreamQueue<string>();
      const resultPromise = queue.next();
      queue.push('hello');
      const result = await resultPromise;
      expect(result).toEqual({ value: 'hello', done: false });
    });

    it('buffers the chunk when no next() is waiting', async () => {
      const queue = new StreamQueue<string>();
      queue.push('buffered');
      const result = await queue.next();
      expect(result).toEqual({ value: 'buffered', done: false });
    });
  });

  describe('end() then next() drains buffered chunks before done', () => {
    it('delivers all buffered chunks in order before reporting done', async () => {
      const queue = new StreamQueue<number>();
      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.end();

      const results: number[] = [];
      let result = await queue.next();
      while (!result.done) {
        results.push(result.value);
        result = await queue.next();
      }

      expect(results).toEqual([1, 2, 3]);
      expect(result.done).toBe(true);
    });

    it('reports done immediately when there are no buffered chunks', async () => {
      const queue = new StreamQueue<string>();
      queue.end();
      const result = await queue.next();
      expect(result).toEqual({ value: undefined, done: true });
    });
  });

  describe('abort() after end() is a no-op', () => {
    it('does not turn a clean finish into a throw when abort() follows end()', async () => {
      const queue = new StreamQueue<string>();
      queue.push('a');
      queue.end();
      queue.abort(new Error('too late'));

      const results: string[] = [];
      let result = await queue.next();
      while (!result.done) {
        results.push(result.value);
        result = await queue.next();
      }

      expect(results).toEqual(['a']);
      expect(result.done).toBe(true);
    });

    it('does not turn a clean finish into a throw when abort() follows end() and no chunks', async () => {
      const queue = new StreamQueue<string>();
      queue.end();
      queue.abort(new Error('too late'));
      const result = await queue.next();
      expect(result).toEqual({ value: undefined, done: true });
    });
  });

  describe('abort() after abort() is a no-op', () => {
    it('second abort() does not overwrite the first error', async () => {
      const queue = new StreamQueue<string>();
      const firstError = new Error('first');
      const secondError = new Error('second');
      queue.abort(firstError);
      queue.abort(secondError);
      await expect(queue.next()).rejects.toThrow('first');
    });
  });

  describe('next() after error rejects every time', () => {
    it('rejects with the same error on repeated next() calls', async () => {
      const queue = new StreamQueue<string>();
      const error = new Error('stream failed');
      queue.abort(error);

      await expect(queue.next()).rejects.toThrow('stream failed');
      await expect(queue.next()).rejects.toThrow('stream failed');
      await expect(queue.next()).rejects.toThrow('stream failed');
    });

    it('rejects the waiting next() promise when abort() is called while awaiting', async () => {
      const queue = new StreamQueue<string>();
      const pending = queue.next();
      queue.abort(new Error('aborted mid-wait'));
      await expect(pending).rejects.toThrow('aborted mid-wait');
    });
  });

  describe('two concurrent next() pulls', () => {
    it('does not orphan the first waiter — both receive chunks in order', async () => {
      const queue = new StreamQueue<string>();
      const a = queue.next();
      const b = queue.next();
      queue.push('one');
      queue.push('two');
      expect(await a).toEqual({ value: 'one', done: false });
      expect(await b).toEqual({ value: 'two', done: false });
    });

    it('resolves all parked waiters as done when end() is called', async () => {
      const queue = new StreamQueue<string>();
      const a = queue.next();
      const b = queue.next();
      queue.end();
      expect(await a).toEqual({ value: undefined, done: true });
      expect(await b).toEqual({ value: undefined, done: true });
    });

    it('rejects all parked waiters when abort() is called', async () => {
      const queue = new StreamQueue<string>();
      const a = queue.next();
      const b = queue.next();
      queue.abort(new Error('boom'));
      await expect(a).rejects.toThrow('boom');
      await expect(b).rejects.toThrow('boom');
    });
  });
});
