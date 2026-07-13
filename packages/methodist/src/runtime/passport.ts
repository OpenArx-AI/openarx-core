// ── Primitive passport (framework §1) ────────────────────────────────────────
//
// A primitive is a *functional with an id and version*, not a signature-bound
// function. Its passport declares the immutable contract the runtime enforces:
// what it may READ (`access`), what it may WRITE (`effects`), and whether it is
// byte-deterministic. inputs/outputs schemas may change WITH the version and are
// owned by the primitive / methodology layer — the runtime never validates them
// (framework §1, runtime §9).

/** Category of primitive (framework §2 / impl §A–E). */
export type PrimitiveKind = 'model-call' | 'algorithmic' | 'transform' | 'retrieval' | 'state';

/** Determinism class — drives the test standard (runtime §7). */
export type Determinism = 'deterministic' | 'model-dependent';

/**
 * Persistent stores a primitive may touch. `access` = read, `effects` = write.
 * The runtime hands the primitive ONLY the handles named here (runtime §4).
 * Append-only stores (journal, activities, run-state transition marks,
 * supersede pointers) reject update/delete at the handle level (runtime §5).
 */
export type StoreName =
  | 'graph'
  | 'dossier'
  | 'journal'
  | 'activities'
  | 'submission'
  | 'config'
  | 'run-state'
  | 'vector'
  | 'source-index'
  | 'hash-index';

/** Append-only stores — the runtime forbids update/delete on their handles. */
export type AppendOnlyStore = 'journal' | 'activities';
/** Mutable stores — everything else. */
export type MutableStore = Exclude<StoreName, AppendOnlyStore>;

export const APPEND_ONLY_STORES: ReadonlySet<StoreName> = new Set<StoreName>([
  'journal',
  'activities',
]);

/** Mandatory passport fields (framework §1). */
export interface Passport {
  /** unique kebab identifier */
  readonly id: string;
  /** implementation version, e.g. 'v1'. Multiple versions coexist (runtime §9). */
  readonly version: string;
  readonly kind: PrimitiveKind;
  /** one-line business goal */
  readonly goal: string;
  /** stores the primitive may READ */
  readonly access: readonly StoreName[];
  /** stores the primitive may WRITE ('none' = empty array = pure) */
  readonly effects: readonly StoreName[];
  readonly determinism: Determinism;
}
