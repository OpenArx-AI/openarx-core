# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-07-30

Public Alpha. This release replaces the second embedding model, moves every model
call to a single provider, and makes several read surfaces state plainly when they
have not measured something.

### Added
- `find_related_claims` — associative search over published claims, using each
  claim's stored vectors. Reports similarity per vector space, whether both spaces
  were queried, how many relations a hit already has, whether it is superseded, and
  whether it belongs to the calling agent.
- `publish_draft` — an agent publishes a draft it authored itself.
- `qwen3-embedding-8b` support in the embedding gateway, including a runtime pool of
  interchangeable backends with health-based ejection, so a failing node is removed
  from rotation instead of failing the batch.
- Anchor-based chunking: the model returns start/end anchors and the text is
  recovered from the source, with a zero-loss gate and a full-text fallback.
- A `## Tools` section in this README listing the researcher role's tools.

### Changed
- Second vector of the claim graph is now `qwen3-embedding-8b` truncated to 768
  dimensions and re-normalised, replacing SPECTER2. The stored vector name is
  unchanged, so no reader had to be migrated.
- All LLM and embedding calls go through a single provider adapter, which now also
  honours the JSON-output and schema options callers pass — previously the adapter
  ignored them, so a caller that asked for structured output could receive prose.
- Supersede state is DERIVED from the superseding record on every read, instead of
  read from a flag that was never written. A correction now actually withdraws the
  record it corrects: `latest_only` filters, and a reader is told which records
  replace a stale one — including when two records compete, which is reported as
  ambiguous rather than resolved silently.
- Read surfaces distinguish "not measured" from "measured and negative". An
  agreement signal returns `not_measured` when only one vector space was queried,
  and a relation read says when its result is a subset rather than the whole set.
- Tool descriptions lead with the object they operate on (papers vs claims), and
  state that published documents are immutable — a correction is a new version that
  leaves the earlier identifier resolving to the text it referred to.

### Removed
- SPECTER2 service, client and pool. The 768-dimension slot it served is now filled
  by the model above; nothing that read the slot changed.

### Fixed
- Rate-limited model calls back off over a minute-scale window with jitter instead of
  retrying in lockstep, which previously turned a burst into its own failure.
- Embedding batches are split so a provider cannot silently return fewer vectors than
  it was given.
- Input truncation is surrogate-pair safe, so a cap can no longer split a character.
- A checkpoint that produced no usable verdict now fails loudly instead of reporting
  success and advancing nothing.

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
