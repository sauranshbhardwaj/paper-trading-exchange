import { describe, expect, it } from 'vitest';
import { KeyedSerialQueue } from './serialQueue.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('KeyedSerialQueue', () => {
  it('runs tasks for the same key one at a time, in order', async () => {
    const queue = new KeyedSerialQueue();
    const log: string[] = [];
    const gate = deferred();

    const first = queue.run('BTC', async () => {
      log.push('first:start');
      await gate.promise;
      log.push('first:end');
    });
    const second = queue.run('BTC', async () => {
      log.push('second');
    });

    await Promise.resolve();
    expect(log).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(['first:start', 'first:end', 'second']);
  });

  it('runs different keys concurrently', async () => {
    const queue = new KeyedSerialQueue();
    const gate = deferred();
    const log: string[] = [];

    const btc = queue.run('BTC', async () => {
      await gate.promise;
      log.push('btc');
    });
    await queue.run('ETH', async () => {
      log.push('eth');
    });

    expect(log).toEqual(['eth']);
    gate.resolve();
    await btc;
    expect(log).toEqual(['eth', 'btc']);
  });

  it('keeps going after a task fails, and passes the error to its caller', async () => {
    const queue = new KeyedSerialQueue();
    const failing = queue.run('BTC', async () => {
      throw new Error('boom');
    });
    const next = queue.run('BTC', async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('cleans up keys once their queue drains', async () => {
    const queue = new KeyedSerialQueue();
    await queue.run('BTC', async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.activeKeys).toBe(0);
  });
});
