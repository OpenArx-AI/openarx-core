# methodist-lab

Isolated lab for the **methodist pipeline** lower layer:

- **Phase 2A — primitive runtime** (`src/runtime/`) — the substrate that runs a
  primitive and moves data. Spec: `openarx-promo/docs/idearank/tz_primitive_runtime.md`.
- **Phase 2B — ~30 primitives** (`src/primitives/`) — atomic, each authored and
  tested on its own. Spec: `.../tz_primitives_impl.md`.
- Primitive passport & data-exchange standard: `.../tz_framework_primitives.md` §1–2.

The interpreter, methodology JSON, MCP endpoints and integration into openarx are
**Phase 3–4 — NOT built here.**

## Isolation contract (Vlad, 2026-07-07)

This folder lives in the core repo but is **decoupled by construction** — while it
is being formed it must not affect the project's build/run and can be deleted or
left unfinished with nothing breaking:

- **Not a workspace member** — `pnpm-workspace.yaml` globs `packages/*`; a
  root-level folder is invisible to `pnpm -r build` / install.
- **Zero `@openarx/*` imports** — no dependency INTO project code. External npm
  packages are allowed (e.g. `canonicalize`, `vitest`).
- **Own toolchain** — own `package.json`, `tsconfig.json`, lockfile and
  `node_modules` (installed with `pnpm install --ignore-workspace`).
- **Excluded from project lint/typecheck** — `methodist/**` is in the root
  eslint `ignores` and root `tsconfig` `exclude`.

## Layout

```
src/runtime/     Phase 2A — registry · invoke · access-enforcement · append-only ·
                 outcomes · observability · versioning · injected model-client
src/primitives/  Phase 2B — model/ algorithmic/ transform/ retrieval/ state/
src/testkit/     mock stores + recorded model client for isolated tests
test/            runtime + per-primitive suites
```

## Runtime (Phase 2A) — implemented

- **Registry** — `id → {version → (impl, passport)}`; exact-version resolve;
  unknown id/version → hard `rejected`; multiple versions coexist (§9).
- **Invocation** — `(id, version, params, inputs)` → `Outcome`. `inputs` arrive
  already resolved (blackboard is the interpreter's, not the runtime's).
- **Access enforcement (§4)** — a primitive gets ONLY the handles named in its
  passport `access`/`effects`; reaching further → `access-violation` → rejected.
- **Append-only (§5)** — journal/activities handles refuse put/patch/delete at the
  handle level → `immutable-store`.
- **Outcome taxonomy (§6)** — `ok` / `returned` (valid business "no") / `failed`
  (technical, retried for model-call) / `rejected` (contract violation).
- **Model-call (§2)** — injected `ModelClient` (Vertex/GOOGLE_AI_API_KEY path at
  integration; no new key); timeout + retry on technical faults only.
- **Observability (§8)** — one `CallRecord` per invocation (id, version,
  hash(params), status, duration, attempts) — no judgment content.

## Primitives (Phase 2B) — wave plan

Bottom-up by testability (deterministic first):

| Wave | Category | Primitives | Status |
|---|---|---|---|
| 1 | transform (C) | canonicalize, resolve-local-ids, compute-hash | **done** (14 tests) |
| 2 | algorithmic (B) | check-stop-rule … filter-latest-only (11) | **done** (17 tests) |
| 3 | retrieval (D) | search-semantic … fetch-run-state (5) | **done** (9 tests) |
| 4 | state (E) | create-run … create-corrective-activity (9) | **done** (12 tests) |
| 5 | model (A) | prepare-context, call-model | **done** (6 tests) |

**Phase 2B COMPLETE — 30 primitives, 72 tests green** (+ integration: all 30 register
across the 5 categories with no id/version collision).

### Mock surface (→ real-environment pass, `openarx-c8h5`)
Where a wave's tests run against mocks/stubs, they must later re-run against the
real environment (Vlad, 2026-07-07). Per-primitive:
- **Wave 1** — `canonicalize` / `compute-hash`: **no mocks**, golden byte/hash
  vectors from the platform — real-env not required. `resolve-local-ids`: tested
  with a **stubbed id-allocator**; real-env pass wires the platform's
  `assignRecordId` (canonicalize→compute-hash→buildRecordId) and confirms ids match.
- **Wave 2** — `check-stop-rule` (run-state), `check-idempotency` (hash-index),
  `crosscheck-tool-usage` (journal): **mock stores** → real-env re-run against the
  live stores. `detect-language`: **stubbed lang-id** → real-env wires fastText/CLD3.
  `validate-schema`, `classify-convergence`, `threshold-zone`, `select-canonical`,
  `apply-supersede-guards`, `compute-superseded-by`, `filter-latest-only`: **pure**
  (data via inputs, composed from retrieval/read-graph upstream) — no real-env needed.
- **Wave 3** — **all 5 read mock stores** (vector, source-index, graph, dossier,
  run-state) → real-env re-run against live Qdrant/Postgres. `search-semantic`
  also uses a **stubbed embedder** → real-env wires the gemini vector path.
- **Wave 4** — **all 9 write mock stores** → real-env re-run against live stores.
  `commit-bundle-atomic` atomicity is modelled as **validate-all-then-apply**;
  real-env replaces it with a real DB transaction. `vectorize-and-store` uses a
  **stubbed embedder**. append-only (journal/activities) enforced by the runtime.
- **Wave 5** — `prepare-context`: **no mocks**, golden prompt assembly — real-env
  not required. `call-model`: **recorded model client** → real-env wires the live
  Vertex/GOOGLE_AI_API_KEY path (context-caching native, no new key).

### Correctness anchors
- `canonicalize` / `compute-hash` reuse the **same external `canonicalize`
  (RFC 8785 JCS, no NFC) + SHA-256** the platform uses, and lock byte-identity
  with the platform's golden vectors as fixtures — **no `@openarx` import**.
  (content_hash identity is catastrophic-breaking — must match layer2 exactly.)
- `call-model` is an interface only; the real client is injected at Phase 4.
- `read-graph` carries the read-harness non-distribution policy (pointer, not
  verbatim excerpt).

## Run

```bash
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
```
