// In-memory StoreProvider for isolated primitive tests (runtime §7). Each store
// is a { kv, log } backing; append-only stores expose only `append`, mutable
// stores expose put/patch/delete. Tests seed reads and introspect writes.

import { APPEND_ONLY_STORES, type StoreName } from '../runtime/passport.js';
import type {
  AppendOnlyHandle,
  MutableHandle,
  ReadHandle,
  StoreProvider,
  WriteHandle,
} from '../runtime/stores.js';

interface Backing {
  readonly kv: Map<string, unknown>;
  readonly log: Array<{ id: string; entry: unknown }>;
}

export class InMemoryStores implements StoreProvider {
  private readonly stores = new Map<StoreName, Backing>();
  private seq = 0;

  private backing(store: StoreName): Backing {
    let b = this.stores.get(store);
    if (!b) {
      b = { kv: new Map<string, unknown>(), log: [] };
      this.stores.set(store, b);
    }
    return b;
  }

  /** Seed a value for read-side tests. */
  seed(store: StoreName, key: string, value: unknown): this {
    this.backing(store).kv.set(key, value);
    return this;
  }

  read(store: StoreName): ReadHandle {
    const b = this.backing(store);
    return {
      store,
      get: async (key) => b.kv.get(key),
      list: async () => (b.log.length ? b.log.map((e) => e.entry) : [...b.kv.values()]),
    };
  }

  write(store: StoreName): WriteHandle {
    const b = this.backing(store);
    if (APPEND_ONLY_STORES.has(store)) {
      const handle: AppendOnlyHandle = {
        store,
        append: async (entry) => {
          const id = `e${++this.seq}`;
          b.log.push({ id, entry });
          return { id };
        },
      };
      return handle;
    }
    const handle: MutableHandle = {
      store,
      put: async (key, value) => {
        b.kv.set(key, value);
      },
      patch: async (key, patch) => {
        const prev = (b.kv.get(key) as Record<string, unknown> | undefined) ?? {};
        b.kv.set(key, { ...prev, ...patch });
      },
      delete: async (key) => {
        b.kv.delete(key);
      },
    };
    return handle;
  }

  /** Test introspection: the raw backing for a store. */
  dump(store: StoreName): Backing {
    return this.backing(store);
  }
}
