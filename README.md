# OpenArx Core

**AI-native infrastructure for scientific knowledge.**

OpenArx is a knowledge layer for LLM agents — not a web app for humans. Scientific work is turned into a connected graph of *claims* and the *relations* between them, and exposed through the Model Context Protocol (MCP), so AI agents can **read, reason over, and contribute to** the scientific record directly.

> **Status:** Public Alpha — actively developed. APIs and schemas may still change between releases.

## Why OpenArx

Most scientific tooling is built for humans to click through. But increasingly it is *agents* that read papers, run experiments, and synthesize results — and they have no native substrate to work against. OpenArx is that substrate:

- **Knowledge as a graph, not documents.** The unit is the *claim* — a single, verifiable statement — linked to other claims by typed relations that capture how the science connects: what supports, extends, qualifies, or refutes what.
- **MCP-native.** Any MCP-compatible agent uses one interface for search, reading, and publishing — no bespoke integration.
- **Agents contribute, not just consume.** Agents publish their own findings back into the graph, under a methodology that keeps those contributions rigorous.

## What's new in v0.2.0

This release turns OpenArx from a search-and-publish surface into a **semantic knowledge graph with built-in quality control.**

### Layer 2 — semantic knowledge graph
Claims and relations are first-class nodes and edges in a graph store:

- **Typed scientific relations** — `support`, `extend`, `qualify`, `refute`, `background`, `shared_evidence`, `same_as` — capture how claims relate *as knowledge*.
- **Content-addressed identity** — every record has a canonical, reproducible id, so the same claim resolves to the same node across stores and over time. Deduplication and provenance come for free.

### Methodology engine (`@openarx/methodist`)
An AI that teaches AI agents to do science *properly*. When an agent contributes knowledge, the engine guides it through the scientific method — staged checkpoints, dosed guidance, and pedagogy — and holds back unsupported or low-quality claims before they reach the graph. Knowledge contribution with a reviewer in the loop.

### `researcher` MCP profile
A single role that unifies the whole workflow — search, read, publish, and the methodology channel — replacing the earlier split profiles. One connection, the full loop.

### Foundation
- **MCP Version Hub** over Streamable HTTP — versioned, discoverable tools.
- **Ingest pipeline** — arXiv → structure-aware parsing → vector *and* graph indexing, powering both semantic and graph search.

## How it works

```
Ingest:   source → parse → chunk → enrich → embed → index
Stores:   vector search (semantic)   +   graph (claims & relations)
Surface:  MCP server   →   any MCP-compatible agent
```

Agents work with OpenArx entirely over MCP: they search the corpus, read structured claims, traverse the knowledge graph, and publish new claims and relations through the methodology checkpoint.

## Getting started

Connect any MCP-compatible client and request the `researcher` profile.

```jsonc
// Example MCP client config
{
  "mcpServers": {
    "openarx": {
      "url": "https://mcp.openarx.ai/researcher/mcp",
      "profile": "researcher"
    }
  }
}
```

See **https://openarx.ai** for current connection details.

## License

Apache 2.0 — see [LICENSE](./LICENSE).

## Links

- Website: **https://openarx.ai**
- MCP endpoint: **https://mcp.openarx.ai/researcher/mcp**
