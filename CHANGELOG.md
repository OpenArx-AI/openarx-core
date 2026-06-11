# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-06-12

Registry-driven coverage release. The ingest pipeline now works from a
per-document registry instead of re-reading arXiv listings, document
identifiers were widened to a collision-free format, and the pipeline
control plane was removed from the HTTP surface.

### Added
- **Per-document coverage registry**: every arXiv listing entry is
  registered as a `status='listed'` document (metadata only) before any
  download. Coverage becomes countable per document; gaps are concrete
  paper ids rather than aggregate counters.
- **Registry-driven ingest**: `openarx ingest` selects work straight from
  the registry (`listed`/`downloaded` within a date period, optional
  category filter, forward/backward traversal). Selection is self-resuming:
  processed documents drop out of the queue by construction. New
  `--downloaded-first` flag drains the downloaded backlog first.
- **`openarx registry-update`** command: fetches arXiv day listings into
  the registry as a separate, trackable operation (days are atomic).
- **`find_by_id` accepts `oarx_id`** (new-format 16-hex ids exactly,
  legacy 8-hex ids resolved by prefix).
- Doctor check `registry-gaps`: reports listed-but-never-downloaded papers
  and exhausted download failures per day; `--fix` downloads them straight
  from registry metadata.

### Changed
- **`oarx_id` widened from 8 to 16 hex chars** (`oarx-` + 16 hex, 64 bits).
  At ~1M documents the 32-bit form produced real collisions; the new form
  makes them negligible. Same sha256 derivation — a legacy id is a prefix
  of the new id and remains resolvable. Migration `029_oarx_id_16hex.sql`
  regenerates all ids and preserves the legacy value in
  `external_ids.oarx_legacy`.
- Downloads landing on an existing document row are now applied as a
  partial read-modify-write update: only download-owned fields are
  written, `external_ids`/`licenses` are merged, processing history is
  appended rather than overwritten.
- `MCP_HOST` accepts a comma-separated list of bind addresses; the
  service binds each address explicitly instead of `0.0.0.0`.

### Removed
- `/api/pipeline/*` HTTP gateway: the pipeline control plane is no longer
  exposed on the MCP listener. Operate the pipeline via the runner's unix
  socket (`openarx` CLI).
- Doctor checks `coverage-gaps` and `coverage-breakdown-drift`
  (superseded by `registry-gaps`).

## [0.1.2] — 2026-06-01

Patch release. Search-quality improvements (soft metadata filtering),
on-demand source-file access over MCP, and reliability/cost fixes in the
ingest chunking and LaTeX parsing stages.

### Added
- **On-demand source files over MCP** — documents can return their
  original LaTeX source and individual source files on request, served
  lazily from the archived upload instead of a persisted copy.
- **Embedding text builder** — dedicated, tested construction of the
  text passed to the embedding models, shared across pipeline stages.

### Changed
- **Soft metadata filtering in search** — filtering chunks by
  `contentType` or `entities` no longer silently drops chunks that lack
  that metadata. Matching chunks rank first; chunks with unknown
  metadata are kept in a lower "unknown" tier rather than excluded, and
  responses report how many unknown-tier chunks were included. Applies
  to `get_chunks`, `search`, `find_methodology`, `find_evidence`, and
  related tools.
- **Tool manifest** (`mcp-server.json`) regenerated to match the
  deployed governance server — updated tool descriptions and input
  schemas.

### Fixed
- **Chunking stability and cost** — the chunker no longer constrains the
  primary model call with a structured-output schema parameter, which on
  math/LaTeX-dense papers inflated output and caused truncation. It now
  validates the returned JSON and retries only the failed batches on a
  higher-capability model with the schema, keeping chunk metadata
  complete while avoiding the truncation/retry storm.
- **LaTeX parsing robustness** — eprint archives are extracted on demand
  for parsing and cleaned up afterward; a content-empty LaTeX parse now
  falls back to the PDF path, so papers whose body lives in an
  un-included supplement file still produce chunks.
- **Resilience to blocked model responses** — the model client now
  handles responses with no candidates (safety/recitation blocks)
  gracefully instead of throwing.

## [0.1.1] — 2026-05-13

Patch release. MCP transport conformance against the registry test
suite, MCP discovery polish, README rewrite for the public mirror, and
an operational env flag for the enrichment worker.

### Changed
- **README** — rewritten for the read-only inspection mirror. The
  document now leads with the vision (AI-native scientific
  infrastructure), explains the multi-layer architecture
  (knowledge / generative / methodology), positions OpenArx against
  end-user search engines, and lists the community channels (Twitter,
  Telegram, Discord, Reddit). Self-install instructions removed —
  this repository is a transparency mirror, not a deployment artifact.
- **Authorization Server discovery** — `/.well-known/oauth-authorization-server`
  now proxies the live document from the Portal instead of serving a
  hand-curated copy. The MCP host stays in sync automatically when the
  Portal rotates endpoints or scope names.
- **OAuth scope advertisement** — protected-resource metadata now
  lists all three production scopes (`openarx:consumer`,
  `openarx:publisher`, `openarx:governance`) instead of only the
  consumer scope.

### Fixed
- **MCP `Accept` header tolerance** (P0-1) — accept clients that send
  only `application/json` or only `text/event-stream` in addition to
  the combined form. Internal header rewrite covers both `req.headers`
  and `req.rawHeaders` so it propagates through Express's body parsers.
- **MCP `Mcp-Session-Id` on `initialize`** (P1-1) — the server now
  emits a session id on the response to `initialize` while still
  operating in stateless mode. Inspectors that gate the connection on
  the presence of the header no longer hang.
- **JSON-RPC envelope codes** (WAVE2-001, WAVE2-003) — distinguish
  unparseable bodies (`-32700`) from well-formed but invalid envelopes
  (`-32600`). A new `validateJsonRpcEnvelope` middleware enforces the
  shape after JSON parsing succeeds.
- **HTTP 405 on unsupported methods** (WAVE2-002) — the MCP endpoints
  return `405 Method Not Allowed` with an `Allow: POST, OPTIONS`
  header instead of falling through to the default handler.
- **HTTP 415 on wrong `Content-Type`** (WAVE2-004) — restored after
  it regressed during the JSON-RPC envelope work. A dedicated
  `checkContentType` middleware now runs ahead of the JSON parser.

### Added
- **`ENRICHMENT_DISABLE_CORE` environment flag** — bypass the CORE
  (core.ac.uk) enrichment source without removing it from the
  pipeline. Set to `1` to substitute a stub client that returns
  `not_found` for every lookup; downstream aggregation handles that
  case unchanged. Intended for temporary use during credential
  rotation or upstream outages.

## [0.1.0] — 2026-05-XX

Initial public release. Public Alpha — APIs and behavior may change.

### Added
- MCP service with three production profiles:
  - **Consumer** (`/v1/mcp`) — hybrid search over the indexed corpus.
  - **Publisher** (`/pub/mcp`) — search plus document submission.
  - **Governance** (`/gov/mcp`) — search plus publishing plus initiative
    and voting tools.
- Sandbox profile (`/dev/mcp`) for RAG experiments.
- Ingest pipeline: parse → chunk → enrich → embed → index, with
  per-stage observability.
- Supporting services: embedding gateway, enrichment worker, BGE
  reranker, SPECTER2 integration.
- Pipeline runner with continuous-window processing, resume semantics,
  and per-document state tracking.
