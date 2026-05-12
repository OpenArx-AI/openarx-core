/**
 * Async semaphore for controlling concurrent access to a resource.
 *
 * acquire() blocks when all slots are taken.
 * release() frees a slot and unblocks the next waiter.
 * withResource() is the RAII pattern: acquire → fn() → release.
 */

export class Semaphore {
  private current = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error(`Semaphore capacity must be >= 1, got ${capacity}`);
  }

  async acquire(): Promise<void> {
    if (this.current < this.capacity) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.current++;
  }

  release(): void {
    this.current--;
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }

  async withResource<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Current number of slots in use */
  get inUse(): number {
    return this.current;
  }

  /** Number of callers waiting for a slot */
  get waiting(): number {
    return this.waiters.length;
  }
}
