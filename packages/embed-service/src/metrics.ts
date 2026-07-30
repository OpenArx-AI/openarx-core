import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const requestsTotal = new Counter({
  name: 'openarx_embed_requests_total',
  help: 'Total /embed requests by model and status',
  labelNames: ['model', 'status'] as const,
  registers: [registry],
});

export const textsTotal = new Counter({
  name: 'openarx_embed_texts_total',
  help: 'Total texts embedded by model and source (cache|provider)',
  labelNames: ['model', 'source', 'provider'] as const,
  registers: [registry],
});

export const requestDurationSeconds = new Histogram({
  name: 'openarx_embed_request_duration_seconds',
  help: 'End-to-end /embed duration in seconds',
  labelNames: ['model'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const providerDurationSeconds = new Histogram({
  name: 'openarx_embed_provider_duration_seconds',
  help: 'Provider call duration in seconds',
  labelNames: ['model', 'provider'] as const,
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const cacheOpsTotal = new Counter({
  name: 'openarx_embed_cache_ops_total',
  help: 'Cache operations by outcome',
  labelNames: ['op', 'outcome'] as const,
  registers: [registry],
});

export const providerErrorsTotal = new Counter({
  name: 'openarx_embed_provider_errors_total',
  help: 'Provider failures triggering fallback',
  labelNames: ['model', 'provider'] as const,
  registers: [registry],
});

export const cacheHitRate = new Gauge({
  name: 'openarx_embed_cache_hit_ratio',
  help: 'Rolling cache hit ratio (0..1)',
  labelNames: ['model'] as const,
  registers: [registry],
});

// ── qwen TEI GPU-pool (populated from the pool at /metrics scrape time) ──
export const teiPoolBackends = new Gauge({
  name: 'openarx_embed_tei_pool_backends',
  help: 'TEI pool backend count by state (total|healthy)',
  labelNames: ['state'] as const,
  registers: [registry],
});
export const teiBackendHealthy = new Gauge({
  name: 'openarx_embed_tei_backend_healthy',
  help: 'TEI backend health (1 healthy, 0 down)',
  labelNames: ['id'] as const,
  registers: [registry],
});
export const teiBackendInflight = new Gauge({
  name: 'openarx_embed_tei_backend_inflight',
  help: 'In-flight requests per TEI backend',
  labelNames: ['id'] as const,
  registers: [registry],
});
export const teiBackendRequests = new Gauge({
  name: 'openarx_embed_tei_backend_requests',
  help: 'Cumulative requests per TEI backend since register',
  labelNames: ['id'] as const,
  registers: [registry],
});
export const teiBackendErrors = new Gauge({
  name: 'openarx_embed_tei_backend_errors',
  help: 'Cumulative errors per TEI backend since register',
  labelNames: ['id'] as const,
  registers: [registry],
});
