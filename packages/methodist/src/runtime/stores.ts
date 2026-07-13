// ── Persistent store handles (runtime §4–5) ──────────────────────────────────
//
// The runtime is store-AGNOSTIC: it only gates WHICH handles a primitive gets
// (by passport `access`/`effects`) and enforces append-only semantics. Concrete
// store behaviour is supplied by a StoreProvider — the testkit provides mocks,
// Core provides real handles at integration (Phase 4). Handle method shapes are
// intentionally thin; primitives narrow inputs/outputs themselves.

import type { StoreName } from './passport.js';

// Handle OPERATIONS are async (real backends — Neo4j / Postgres / Qdrant — are
// async; the Phase 1 real-env pass surfaced the sync-handle gap). Acquiring a handle
// (ctx.read/write) stays sync — it only gates by access; the I/O awaits.
export interface ReadHandle {
  readonly store: StoreName;
  get(key: string): Promise<unknown>;
  list(spec?: unknown): Promise<unknown[]>;
}

export interface WriteHandle {
  readonly store: StoreName;
}

/** Immutable stores (journal, activities): only append is permitted. */
export interface AppendOnlyHandle extends WriteHandle {
  append(entry: unknown): Promise<{ id: string }>;
}

/** Mutable stores (graph, dossier, run-state, vector, …). */
export interface MutableHandle extends WriteHandle {
  put(key: string, value: unknown): Promise<void>;
  patch(key: string, patch: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Supplies concrete handles for named stores. The runtime asks for a handle
 * ONLY after it has verified the primitive declared the store; enforcement of
 * that gate lives in the ctx (context.ts), never here.
 */
export interface StoreProvider {
  read(store: StoreName): ReadHandle;
  write(store: StoreName): WriteHandle;
}
