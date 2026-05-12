/**
 * Google Vertex AI direct LLM client.
 *
 * Two auth modes (configured via VertexLlmConfig):
 * 1. API Key — simple, append ?key= to URL. May have output token caps.
 * 2. Service Account — full OAuth2 access, no token limits.
 *    Requires GOOGLE_SA_KEY_FILE env var pointing to service account JSON.
 *
 * Env vars:
 *   GOOGLE_AI_API_KEY      — API key (mode 1)
 *   GOOGLE_SA_KEY_FILE     — path to service account JSON (mode 2, takes priority)
 *   GOOGLE_CLOUD_PROJECT   — GCP project ID (required for mode 2)
 *   GOOGLE_CLOUD_LOCATION  — GCP region (default: us-central1)
 *   VERTEX_LLM_RPM         — rate-limit cap (default 2000, in-process token bucket)
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ModelOptions, ModelResponse, ModelTask } from '@openarx/types';
import { retry } from './retry.js';
import { TokenBucket } from './token-bucket.js';

const DEFAULT_MODEL = 'gemini-3-flash-preview';

const DEFAULT_RPM = 2000;

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3.1-pro-preview': { input: 2.5, output: 15 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash-preview-05-20': { input: 0.15, output: 0.60 },
};

export interface VertexLlmConfig {
  apiKey?: string;
  serviceAccountKeyFile?: string;
  projectId?: string;
  location?: string;
  defaultModel?: string;
}

interface VertexResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
    finishReason?: string;
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

// ── Service Account OAuth2 token management ─────────────────

class ServiceAccountAuth {
  private readonly email: string;
  private readonly privateKey: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(keyFile: string) {
    const raw = JSON.parse(readFileSync(keyFile, 'utf-8')) as ServiceAccountKey;
    this.email = raw.client_email;
    this.privateKey = raw.private_key;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600; // 1 hour

    // Build JWT
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: this.email,
      sub: this.email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: expiry,
      scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language',
    })).toString('base64url');

    const signInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signInput);
    const signature = signer.sign(this.privateKey, 'base64url');
    const jwt = `${signInput}.${signature}`;

    // Exchange JWT for access token
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OAuth token exchange failed (${resp.status}): ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { access_token: string; expires_in: number };
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000; // refresh 5 min early

    return this.cachedToken;
  }
}

// ── LLM Client ──────────────────────────────────────────────

export class VertexLlm {
  private readonly defaultModel: string;
  private readonly authMode: 'api_key' | 'service_account';
  private readonly bucket: TokenBucket;

  // Mode 1: API Key
  private readonly apiKey?: string;
  private readonly apiKeyUrl: string = 'https://aiplatform.googleapis.com/v1/publishers/google/models';

  // Mode 2: Service Account
  private readonly saAuth?: ServiceAccountAuth;
  private readonly saUrl?: string;

  constructor(config: VertexLlmConfig) {
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;

    // In-process rate limiter: pace all outbound Vertex LLM calls through a
    // single FIFO queue. Prevents N parallel workers + retries from bursting
    // past the per-model RPM quota (previous behaviour: 10 workers × 429 →
    // all sleep 1s → all retry simultaneously → another 429 burst).
    const rpm = parseInt(process.env.VERTEX_LLM_RPM ?? String(DEFAULT_RPM), 10);
    this.bucket = new TokenBucket(rpm);

    const saKeyFile = config.serviceAccountKeyFile ?? process.env.GOOGLE_SA_KEY_FILE;

    if (saKeyFile) {
      // Mode 2: Service Account (priority)
      this.authMode = 'service_account';
      this.saAuth = new ServiceAccountAuth(saKeyFile);
      const project = config.projectId ?? process.env.GOOGLE_CLOUD_PROJECT;
      const location = config.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
      if (!project) {
        throw new Error('GOOGLE_CLOUD_PROJECT is required for Service Account auth');
      }
      this.saUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
      console.error(`[vertex] Auth: Service Account (generativelanguage API, project=${project})`);
    } else if (config.apiKey) {
      // Mode 1: API Key
      this.authMode = 'api_key';
      this.apiKey = config.apiKey;
      this.apiKeyUrl = 'https://aiplatform.googleapis.com/v1/publishers/google/models';
      console.error('[vertex] Auth: API Key');
    } else {
      throw new Error('Either GOOGLE_SA_KEY_FILE or GOOGLE_AI_API_KEY is required');
    }

    const intervalMs = (60_000 / rpm).toFixed(1);
    console.error(`[vertex-llm] rate-limit: RPM=${rpm}, interval=${intervalMs}ms (in-process bucket, retries share the queue)`);
  }

  async complete(
    task: ModelTask,
    prompt: string,
    options?: ModelOptions,
  ): Promise<ModelResponse> {
    const model = options?.model ?? this.defaultModel;

    const result = await retry(
      () => this.callApi(model, prompt, options),
      `vertex-${task}`,
    );

    const text = result.candidates[0]?.content?.parts?.[0]?.text ?? '';
    const finishReason = result.candidates[0]?.finishReason;
    const inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;
    const rates = COST_PER_MILLION[model] ?? { input: 0.075, output: 0.30 };
    const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

    if (finishReason === 'MAX_TOKENS') {
      console.warn(`[vertex:${this.authMode}] Output truncated (MAX_TOKENS): ${inputTokens} in → ${outputTokens} out, model=${model}`);
    }

    return { text, model, provider: 'vertex', inputTokens, outputTokens, cost, finishReason };
  }

  private async callApi(
    model: string,
    prompt: string,
    options?: ModelOptions,
  ): Promise<VertexResponse> {
    let url: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this.authMode === 'service_account' && this.saAuth && this.saUrl) {
      const token = await this.saAuth.getAccessToken();
      url = `${this.saUrl}/${model}:generateContent`;
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      url = `${this.apiKeyUrl}/${model}:generateContent?key=${this.apiKey}`;
    }

    // Acquire slot AFTER OAuth refresh (OAuth goes to oauth2.googleapis.com,
    // not the LLM endpoint — doesn't count against our RPM). Every attempt
    // reaches this line, including retries from retry.ts → they share the queue.
    await this.bucket.acquire();

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: options?.maxTokens ?? 65536,
          temperature: options?.temperature ?? 0,
          // Disable thinking/reasoning — not needed for chunking/enrichment tasks.
          // Thinking tokens consume output budget and cause MAX_TOKENS truncation.
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Vertex AI failed (${resp.status}): ${body.slice(0, 200)}`);
    }

    return (await resp.json()) as VertexResponse;
  }
}
