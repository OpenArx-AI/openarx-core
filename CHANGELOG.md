# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
