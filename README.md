# OpenArx

Open AI-native infrastructure for scientific knowledge — a multi-persona
MCP service plus an ingest pipeline for research papers.

> **Status:** Public Alpha (`v0.1.0`). APIs and behavior may change.
> Project home: **openarx.ai**. Public MCP endpoint: **mcp.openarx.ai**.

## What this is

OpenArx makes scientific literature directly usable by AI agents. The
project provides:

- **A multi-persona MCP service** that exposes the corpus through three
  production profiles, each addressing a different audience.
- **An ingest pipeline** that brings external sources (currently arXiv)
  into a structured, searchable form: parse → chunk → enrich → embed →
  index.
- **Supporting services** for embedding, enrichment, and reranking.

The MCP service is built on the Model Context Protocol so any
MCP-capable client — Claude Desktop, Claude Code, Cursor, agents built
on the Anthropic SDK — can connect and use it.

## MCP profiles

The MCP service runs as a single process and exposes four endpoints:

| Profile | URL path | For | What it adds |
|---|---|---|---|
| **Consumer** | `/v1/mcp` | AI agents reading research | 15 search tools |
| **Publisher** | `/pub/mcp` | Authors and reviewers | Consumer tools + document submission |
| **Governance** | `/gov/mcp` | Network participants | Publisher tools + initiative and voting |
| **Sandbox** | `/dev/mcp` | RAG experiments | Experimental tools, may break |

Consumer is the entry point for most agents. Publisher and Governance
are supersets — each builds on the previous one.

## Repository layout

```
packages/
  mcp/             MCP service (4 profile endpoints)
  ingest/          Multi-stage ingest pipeline + runner
  api/             Storage layer + internal REST API
  types/           Shared TypeScript types
  cli/             Admin CLI (stats, costs, status)
  embed-service/   Embedding gateway with Redis cache
  enrichment/      Enrichment worker (code, datasets, benchmarks)
  specter/         SPECTER2 embedding microservice (Python)
  reranker/        BGE Reranker v2-m3 microservice (Python)
```

## Quick start

Prerequisites:

- Node.js 24 or later
- pnpm 9 or later
- PostgreSQL 16
- Qdrant
- Redis

Install and build:

```bash
pnpm install
pnpm build
```

Database setup:

```bash
pnpm --filter @openarx/api migrate
```

Run the MCP service locally:

```bash
pnpm --filter @openarx/mcp start
```

Each package has its own configuration via environment variables. The
Python services (`specter`, `reranker`) ship with Dockerfiles and run
as separate containers.

## Connecting an MCP client

Add an entry to your MCP client configuration. Example for Claude
Desktop or Claude Code:

```json
{
  "mcpServers": {
    "openarx": {
      "type": "http",
      "url": "https://mcp.openarx.ai/v1/mcp"
    }
  }
}
```

Replace `/v1/mcp` with `/pub/mcp` or `/gov/mcp` for the broader
profiles.

## Documentation

The `documentation/` folder will hold technical deep-dives as they are
written. For now this README is the main entry point.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for guidelines.

## Security

Please report security issues privately. See [SECURITY.md](SECURITY.md)
for the responsible disclosure process.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Credits

See [AUTHORS](AUTHORS) for the list of project contributors and supporters.
