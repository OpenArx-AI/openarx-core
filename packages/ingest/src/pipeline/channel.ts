/**
 * Bounded async channel for pipeline stage communication.
 *
 * - send() blocks when buffer is full (backpressure)
 * - receive() blocks when buffer is empty
 * - close() signals no more items; receive() returns null after drain
 */

export class Channel<T> {
  private buffer: T[] = [];
  private closed = false;
  private waitingReaders: Array<(value: T | null) => void> = [];
  private waitingWriters: Array<() => void> = [];

  constructor(private readonly capacity = 1) {}

  async send(item: T): Promise<void> {
    if (this.closed) throw new Error('Channel is closed');

    // If a reader is waiting, hand off directly (skip buffer)
    if (this.waitingReaders.length > 0) {
      const reader = this.waitingReaders.shift()!;
      reader(item);
      return;
    }

    // If buffer has room, enqueue
    if (this.buffer.length < this.capacity) {
      this.buffer.push(item);
      return;
    }

    // Buffer full — wait for space (backpressure)
    await new Promise<void>((resolve) => {
      this.waitingWriters.push(resolve);
    });
    this.buffer.push(item);
  }

  async receive(): Promise<T | null> {
    // If buffer has items, dequeue
    if (this.buffer.length > 0) {
      const item = this.buffer.shift()!;
      // Wake a waiting writer if any
      if (this.waitingWriters.length > 0) {
        const writer = this.waitingWriters.shift()!;
        writer();
      }
      return item;
    }

    // Buffer empty and closed — signal end
    if (this.closed) return null;

    // Buffer empty — wait for an item
    return new Promise<T | null>((resolve) => {
      this.waitingReaders.push(resolve);
      // If closed while waiting, resolve null
      if (this.closed && this.buffer.length === 0) {
        resolve(null);
      }
    });
  }

  close(): void {
    this.closed = true;
    // Wake all waiting readers with null
    for (const reader of this.waitingReaders) {
      reader(null);
    }
    this.waitingReaders = [];
    // Wake all waiting writers (they'll see closed state)
    for (const writer of this.waitingWriters) {
      writer();
    }
    this.waitingWriters = [];
  }

  get size(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
