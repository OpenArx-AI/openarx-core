/**
 * ResourcePool — named semaphore registry for pipeline resources.
 *
 * Each resource (llm_chunking, gemini_embed, specter2_embed, etc.)
 * has a configurable capacity. Documents acquire/release resources
 * as they move through pipeline steps.
 */

import { Semaphore } from '../lib/semaphore.js';

export interface ResourceStats {
  name: string;
  capacity: number;
  inUse: number;
  waiting: number;
}

export class ResourcePool {
  private readonly resources = new Map<string, Semaphore>();

  /** Register a resource with a given capacity. Idempotent — re-registration updates capacity only if not yet registered. */
  register(name: string, capacity: number): void {
    if (!this.resources.has(name)) {
      this.resources.set(name, new Semaphore(capacity));
    }
  }

  /** Acquire a slot for the named resource. Blocks if at capacity. */
  async acquire(name: string): Promise<void> {
    const sem = this.resources.get(name);
    if (!sem) throw new Error(`Resource "${name}" not registered`);
    await sem.acquire();
  }

  /** Release a slot for the named resource. */
  release(name: string): void {
    const sem = this.resources.get(name);
    if (!sem) throw new Error(`Resource "${name}" not registered`);
    sem.release();
  }

  /** Acquire → fn() → release (RAII). */
  async withResource<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const sem = this.resources.get(name);
    if (!sem) throw new Error(`Resource "${name}" not registered`);
    return sem.withResource(fn);
  }

  /** Snapshot of all resource utilization. */
  stats(): ResourceStats[] {
    const result: ResourceStats[] = [];
    for (const [name, sem] of this.resources) {
      result.push({
        name,
        capacity: sem.capacity,
        inUse: sem.inUse,
        waiting: sem.waiting,
      });
    }
    return result;
  }

  /** Check if a resource is registered. */
  has(name: string): boolean {
    return this.resources.has(name);
  }
}
