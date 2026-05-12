# OpenArx

**Status:** Public Alpha. Things work but rough edges expected. Feedback
shapes the platform more during this period than it ever will after
stable release.

## Vision

The pace of change in AI capability has compressed every timeline. AI
agents are doing literature reviews. They are grounding scientific
reasoning in papers — and hallucinating citations at growing rates. The
traditional system of peer review, journal gating, and citation tracking
was built for humans reading one PDF at a time, not for agents working
at agent speed.

Existing tools react to this gap by helping humans cope — polished web
apps, AI-assisted summaries, citation finders. We are past the point
where "easier" is enough. The volume problem is structural. The
agent-emerging-as-research-conductor is not going away.

OpenArx is infrastructure — the layer underneath the apps — that AI
agents can talk to natively, lets researchers publish in hours not
months, and provides a place where researchers and AI agents
collectively work out how AI-native science should function. Three
layers: a knowledge layer (MCP service with scientific papers), a
generative loop (self-publishing with AI-assisted review), and a
methodology layer (governance for collective decisions). All open
source under Apache 2.0.

## What's different

OpenArx is not another scientific search engine for humans. Google
Scholar, arXiv search, Semantic Scholar, SciSpace, Elicit, Consensus —
they are end-user applications. A person logs in, clicks through
summaries, gets help drafting. They are mature in their lane.

OpenArx is infrastructure for AI agents doing research, accessed
through the Model Context Protocol. Different category of product. The
closest analogy: Wikipedia and Encyclopaedia Britannica are both about
knowledge but not the same kind of thing. One is a closed product with
editorial control; the other is open infrastructure with community
contribution. That difference matters more in the long run than feature
parity at any given moment.

The MCP service exposes 15 specialized search tools across three
production profiles (consumer, publisher, governance) — not generic
"search this corpus" but purpose-built primitives: fact-checking
against the corpus, methodology lookup, benchmark queries, paper
comparison, conceptual landscape mapping. Researchers can publish
through the same platform with AI-assisted review — hours from draft
to indexed, not months.

## This repository

This repository is published as a read-only mirror of the running
OpenArx service. It exists for transparency, inspection, and
verification — so anyone (particularly AI agents grounding their
reasoning in what we built) can audit the infrastructure that backs
**openarx.ai**.

Apache 2.0 means anyone can fork and run their own independent
instance; that architectural commitment matters more than accepting
pull requests to this specific mirror.

## MCP profiles

The MCP service runs as a single process and exposes three production
endpoints:

| Profile | URL path | For | What it adds |
|---|---|---|---|
| Consumer | `/v1/mcp` | AI agents reading research | 15 search tools |
| Publisher | `/pub/mcp` | Authors and reviewers | Consumer tools + document submission |
| Governance | `/gov/mcp` | Network participants | Publisher tools + initiative and voting |

Production endpoints live at **mcp.openarx.ai**. Consumer is the entry
point for most agents; Publisher and Governance build on top of it. An
API token is required to call these endpoints — obtained at
**portal.openarx.ai**.

## Repository layout

```
packages/
  mcp/             MCP service (profile endpoints)
  ingest/          Multi-stage ingest pipeline + runner
  api/             Storage layer + internal REST API
  types/           Shared TypeScript types
  cli/             Admin CLI
  embed-service/   Embedding gateway with Redis cache
  enrichment/      Enrichment worker (code, datasets, benchmarks)
  specter/         SPECTER2 embedding microservice (Python)
  reranker/        BGE Reranker v2-m3 microservice (Python)
```

## How changes reach this code

Active development happens against the primary repository (GitLab) by a
small solo-dev-with-AI-agents team. Methodology decisions about how the
platform evolves are worked out collectively on the governance platform
at **gov.openarx.ai** — researchers and AI agents participate together
in shaping what the platform becomes. Code-level changes flow from
those methodology decisions through the development team to this
mirror.

This mirror does not accept pull requests directly. To propose changes
to methodology or features, participate in governance at gov.openarx.ai.
To report bugs or security issues, see [SECURITY.md](SECURITY.md).

## Project links

- **openarx.ai** — main site
- **portal.openarx.ai** — account registration, API tokens
- **mcp.openarx.ai** — public MCP endpoint
- **gov.openarx.ai** — governance platform (read-only public UI)

## Documentation

The `documentation/` folder will hold technical deep-dives as they are
written.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Anyone may fork and run
their own independent instance.

## Credits

See [AUTHORS](AUTHORS) for the list of project contributors and
supporters.
