# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
