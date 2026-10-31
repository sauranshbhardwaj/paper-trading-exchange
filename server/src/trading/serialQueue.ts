/**
 * Runs async tasks one at a time per key (here: per market).
 *
 * Node is single-threaded, but `await` lets other requests run in between.
 * Without this, two orders for BTC-USD could both read the in-memory book,
 * both decide to fill the same resting order, and both save — a double fill.
 * Different markets still run in parallel.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The tail never rejects, so one failed task doesn't block the ones after it.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with work queued or running (for tests and diagnostics). */
  get activeKeys(): number {
    return this.tails.size;
  }
}
