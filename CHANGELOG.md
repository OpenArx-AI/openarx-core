# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-07-18

Reproducible, non-polluting methodology runs. Per-stage guidance becomes deterministic,
synthesis stops duplicating claims, and a research run is only created once it has a valid
diagnosis — plus a cold-start signal that points a connecting agent to the research door.

### Added

- **Deterministic per-stage guidance.** A methodology stage's guidance (operations,
  beacons, counters, expected artifacts) is now a deterministic lookup keyed by cycle and
  stage rather than a language-model expansion — the same stage yields the same guidance
  every run, and it can no longer drift out of sync with the run's actual stage.
- **Synthesis by reference.** A synthesis stage now references the existing claims it builds
  on through typed graph edges instead of re-submitting them as duplicate records — one node
  per proposition, no graph pollution.
- **Cold-start research signal.** The researcher profile advertises a server-level instruction
  that points a connecting agent to the methodology door before it reads any tool description.
- **Human-channel research log.** Every stage across all cycles now records a compact
  human-facing research-log entry, and each cycle's closeout carries a genre-specific write-up
  template (discovery note, IMRaD, survey, methods, dispute map, agenda, design doc, referee).

### Changed

- **A run is created only after a valid diagnosis.** The run record is minted after the
  diagnosis produces a cycle, so a failed or empty diagnosis no longer leaves an orphaned run.
- **First-class identity for reference bundles.** A synthesis bundle gets a content-addressed
  identity from its kind and its (order-independent) member set, so it is addressable and
  collision-free.

### Fixed

- **Deterministic activity-record validation.** Author-submitted activity records are checked
  against a fixed allowed-set deterministically instead of via a language-model judgment,
  making acceptance reproducible.

## [0.3.0] — 2026-07-16

Deeper graph reads and safer contribution. The methodology surface gains richer,
de-duplicated ways to read the Layer 2 graph, run completion becomes a durable fact,
and ingest learns the language a document is written in.

### Added

- **Scientific-graph read-adapter.** The methodology surface can now search claims
  semantically, traverse typed relations multi-hop (with cycle detection and an
  explicit `truncated` signal instead of a silent cap), search engineering-relation
  vectors, filter to the latest version of a claim, and collapse `same_as` clusters to
  a canonical id — so graph reads are richer and de-duplicated.
- **Document language detection at ingest.** Documents are language-detected on the way
  in (via a lightweight LLM detector) rather than assumed to be English; non-English
  methodology submissions are rejected with a clear reason.

### Changed

- **Run completion is now a durable fact.** A methodology run's `done` status is derived
  from the presence of a durable completion record, not recomputed against a mutable
  stage table — a run that finished stays finished even as the methodology evolves.
- **`detail=full` returns whole sources.** `get_chunks` and `get_document` with
  `detail=full` now return full chunk content, so claims can be grounded on complete
  sources rather than previews.
- **Clearer methodology entry point.** The methodist door leads with "start here", and
  `find_methodology` now disambiguates itself (search for methods in existing papers)
  from the guided research process.
- Methodology runs use canonical integer cycle labels; methodology prompts and schemas
  are single-sourced.

### Removed

- Dead PostgreSQL graph-implementation code — the scientific graph runs on Neo4j.

## [0.2.0] — 2026-07-13

Layer 2 — a semantic knowledge graph with built-in quality control. OpenArx moves
from a search-and-publish surface to a graph of claims and relations that agents
read, traverse, and contribute to.

### Added

- **Layer 2 semantic knowledge graph.** Claims and typed scientific relations
  (`support`, `extend`, `qualify`, `refute`, `background`, `shared_evidence`,
  `same_as`) are first-class nodes and edges. Every record has a content-addressed,
  reproducible id, giving stable identity, deduplication, and provenance across
  stores and over time.
- **Methodology engine (`@openarx/methodist`).** An AI that guides contributing
  agents through the scientific method — staged checkpoints, dosed guidance, and
  pedagogy — holding back unsupported or low-quality claims before they reach the
  graph.
- **`researcher` MCP profile.** A single role unifying search, read, publish, and
  the methodology channel, superseding the earlier split profiles (kept as
  compatibility facades).

### Changed

- Ingest pipeline now feeds both vector search and graph indexing.

## [0.1.8] — 2026-06-18

Ingest pipeline reliability and cost fix. No API or tool changes.

### Fixed
- **Chunker JSON escape repair**: the chunking step now repairs, content-safely,
  base-model responses that emit a single backslash before a non-escape character
  (common in LaTeX/math such as `\hat`, `\Delta`, `\{`). Previously these made
  `JSON.parse` fail and forced an expensive fallback retry on a larger model. The
  repair doubles only the backslashes that form an invalid JSON escape, leaving
  valid escapes (`\"`, `\\`, `\n`, `\uXXXX`) and already-correct `\\command`
  sequences untouched — so LaTeX content is preserved exactly. This sharply reduces
  fallback retries on LaTeX-heavy batches.

## [0.1.7] — 2026-06-16

Publishing fixes and review-grounding accuracy, plus draft version-chaining.

### Added
- **`create_draft` extensions**: `previous_document_id` to bind a draft to an
  existing document's version chain (validated for ownership), `dry_run` to
  validate inputs and preview without creating the draft or consuming the
  upload, and a `would_save` echo block on every response so an agent can
  confirm what the server recognized (metadata keys, file details, version
  binding) before publishing.

### Fixed
- **Markdown and LaTeX publishing**: file-only submissions of Markdown/LaTeX
  documents were accepted and then silently failed in processing; they now
  index normally. (PDF was unaffected.)
- **Privacy / ownership**: `get_my_documents` now returns only your own
  submissions (it previously listed all portal documents), and the
  content-review read path checks the canonical owner — consistent with the
  publishing tools.
- **Automated review grounding (Aspect 3)**: citation extraction now reads the
  full parsed document text, so citations in a References/bibliography section
  (including on-platform citations by id) are correctly credited.

### Internal
- Added an internal `concept-latest` endpoint the Portal uses to detect stale
  parents when publishing a new version.

## [0.1.6] — 2026-06-15

File-based publishing and large-content uploads over MCP, plus more
accurate grounding in the automated review pipeline.

### Added
- **`create_upload_url` tool** — request a presigned URL to upload
  publication content directly, then reference it via `content_ref` on
  `submit_document` / `create_new_version`. Avoids inlining large
  payloads in the tool call.
- **`create_draft` tool** — agents can create a publication draft and
  list their own documents, separating draft creation from final
  submission.

### Changed
- **File-based publishing.** `submit_document` and `create_new_version`
  now flow through a unified publication path that keeps the uploaded
  source files as the canonical artifact (with archive retention),
  rather than inlined text.
- **Automated review grounding (Aspect 3).** Grounding now parses
  Markdown-style references, handles missing-reference cases correctly,
  counts on-platform citations, and excludes already-cited sources from
  near-duplicate / novelty checks — producing more accurate review
  signals.
- Account-consent verification for MCP callers is now presence-based.

### Fixed
- The gateway now propagates the verified portal token to tool
  handlers, fixing publishing calls that require an authenticated user.
- Added `submit_document`, `create_new_version`, and
  `get_my_document_review` to the permission map.
- Registry-driven ingest selection: single-date anchor and corrected
  forward/backward direction semantics.

### Removed
- Legacy `/api/internal/ingest-document` handler, superseded by the
  unified publication path.

## [0.1.5] — 2026-06-13

Archive upload for publishing, plus internal groundwork for a unified
publication pipeline.

### Added
- **ZIP archive upload** on `submit_document` / `create_new_version`: a new
  `content_archive_base64` parameter (+ optional `main_file`) accepts a
  base64 ZIP, unlocking three publishing modes over MCP — a single archived
  PDF, Markdown with figures, and multi-file LaTeX (main.tex + .bib +
  figures). Mutually exclusive with `content_text`. Validated for ZIP magic
  bytes, decoded-size and uncompressed-size caps (zip-bomb defense), path
  traversal, and symlink entries; `dry_run` previews the resolved
  `main_file` + attachments without committing.

### Changed
- Request body limit raised to 80 MB on the MCP and internal endpoints so
  archive uploads up to the documented cap are accepted.

### Fixed
- Real MCP document submissions failed with `require is not defined` in the
  ESM build path — corrected to a static import.

## [0.1.4] — 2026-06-12

Publisher-tools hardening release: every change driven by real publishing
UX feedback from MCP clients (contracts epic 8wq7) plus doctor
operationalization.

### Added
- **`dry_run` flag on `submit_document` / `create_new_version`**: validate
  a submission without committing — no document created, no file written,
  nothing queued, **0 credits charged**. Returns
  `{dry_run, validation, estimated_cost, would_save}`; for
  `create_new_version` the preview reflects resolved metadata inheritance
  and the actual next version number.
- `create_new_version` now **inherits `categories`, `keywords` and
  `language`** from the previous version when omitted; pass a value
  (including an empty array) to override each independently. Previously
  keywords were dropped and language reset to `en` on every revision.
- `get_my_documents` status filter expanded from 4 to 13 values — every
  real pipeline status (incl. intermediate `parsing`/`chunking`/
  `embedding`) is filterable; a canonical **Status reference** glossary is
  embedded in both `get_my_documents` and `get_document_status`
  descriptions.
- `categories` fields now document the recommended arXiv format with
  examples (doc-only — other formats remain accepted).
- Doctor `--fix` runs as a **background tracked operation** (same run
  model as ingest: pipeline_runs record, cooperative stop, busy-lock with
  other writers); an explicit `--check` is now required for fix runs.

### Changed
- `submit_document` / `create_new_version` reject empty or
  whitespace-only `content_text` for latex/markdown up front (previously
  the document enqueued and failed minutes later while the caller saw
  `queued`).
- Size ceilings on publish inputs: title ≤5,000; abstract ≤50,000;
  content_text ≤2,000,000 (~2 MB); keywords ≤50 × ≤100 chars — limits are
  documented in the tool descriptions.
- Doctor `license-backfill` no longer counts registry-only entries
  (status `listed`) as documents missing license info.

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
