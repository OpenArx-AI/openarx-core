// ── Access context (runtime §4) ──────────────────────────────────────────────
//
// buildContext returns the ONLY door a primitive has to persistent data. It
// hands back exactly the handles named in the passport `access` (read) and
// `effects` (write); reaching for anything else throws `access-violation`,
// which the invoker maps to a `rejected` outcome. Write handles for append-only
// stores are wrapped so update/delete/put are refused at the handle level
// (runtime §5) even if the provider mistakenly returns a mutable handle.

import {
  APPEND_ONLY_STORES,
  type AppendOnlyStore,
  type MutableStore,
  type Passport,
  type StoreName,
} from './passport.js';
import { AccessViolation, ImmutableStoreError } from './outcomes.js';
import type { AppendOnlyHandle, MutableHandle, ReadHandle, StoreProvider, WriteHandle } from './stores.js';

/** The access door handed to a primitive. */
export interface Ctx {
  /** Read handle for `store`; throws AccessViolation if not in `access`. */
  read(store: StoreName): ReadHandle;
  /** Write handle; append-only stores yield an AppendOnlyHandle, others a
   *  MutableHandle. Throws AccessViolation if `store` is not in `effects`. */
  write(store: AppendOnlyStore): AppendOnlyHandle;
  write(store: MutableStore): MutableHandle;
  write(store: StoreName): WriteHandle;
}

const APPEND_ONLY_ALLOWED = new Set(['append', 'store']);

/** Wrap a write handle so only `append`/`store` are reachable (runtime §5). */
function guardAppendOnly(handle: WriteHandle, store: StoreName): WriteHandle {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !APPEND_ONLY_ALLOWED.has(prop)) {
        throw new ImmutableStoreError(`store '${store}' is append-only; '${prop}' is forbidden`);
      }
      return Reflect.get(target, prop, receiver);
    },
    set(_t, prop) {
      throw new ImmutableStoreError(`store '${store}' is append-only; cannot set '${String(prop)}'`);
    },
    deleteProperty(_t, prop) {
      throw new ImmutableStoreError(`store '${store}' is append-only; cannot delete '${String(prop)}'`);
    },
  });
}

export function buildContext(passport: Passport, provider: StoreProvider): Ctx {
  const access = new Set<StoreName>(passport.access);
  const effects = new Set<StoreName>(passport.effects);
  const read = (store: StoreName): ReadHandle => {
    if (!access.has(store)) {
      throw new AccessViolation(`'${passport.id}' may not READ '${store}' (not in access)`);
    }
    return provider.read(store);
  };
  const write = (store: StoreName): WriteHandle => {
    if (!effects.has(store)) {
      throw new AccessViolation(`'${passport.id}' may not WRITE '${store}' (not in effects)`);
    }
    const handle = provider.write(store);
    return APPEND_ONLY_STORES.has(store) ? guardAppendOnly(handle, store) : handle;
  };
  // The overloaded return types are a compile-time convenience; the single
  // implementation returns the correct concrete handle at runtime.
  return { read, write } as Ctx;
}
