import type { EmbedCache } from './cache.js';
import type { EmbedRequest, EmbedResult, ModelHandler, SupportedModel } from './handlers/types.js';
import {
  cacheHitRate,
  cacheOpsTotal,
  providerDurationSeconds,
  textsTotal,
} from './metrics.js';

export class EmbedRouter {
  private readonly handlers = new Map<SupportedModel, ModelHandler>();

  constructor(private readonly cache: EmbedCache) {}

  register(handler: ModelHandler): void {
    this.handlers.set(handler.model, handler);
  }

  has(model: string): model is SupportedModel {
    return this.handlers.has(model as SupportedModel);
  }

  models(): SupportedModel[] {
    return [...this.handlers.keys()];
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const handler = this.handlers.get(req.model);
    if (!handler) throw new Error(`unsupported model: ${req.model}`);
    const dim = req.outputDimensionality ?? handler.dimensions;
    if (dim !== handler.dimensions) {
      throw new Error(`outputDimensionality ${dim} not supported for ${req.model} (only ${handler.dimensions})`);
    }

    const texts = req.texts;
    const bypassCache = req.bypassCache === true;
    const cached: Array<number[] | undefined> = bypassCache
      ? texts.map(() => undefined)
      : await this.cache.mget(req.model, dim, texts);

    const hitCount = cached.filter((v) => v !== undefined).length;
    const missCount = texts.length - hitCount;
    if (bypassCache) {
      cacheOpsTotal.inc({ op: 'get', outcome: 'bypass' }, texts.length);
    } else {
      cacheOpsTotal.inc({ op: 'get', outcome: 'hit' }, hitCount);
      cacheOpsTotal.inc({ op: 'get', outcome: 'miss' }, missCount);
      textsTotal.inc({ model: req.model, source: 'cache', provider: 'cache' }, hitCount);
      if (texts.length > 0) {
        cacheHitRate.set({ model: req.model }, hitCount / texts.length);
      }
    }

    const vectors: (number[] | undefined)[] = cached.slice();
    let provider = 'cache';
    let inputTokens = 0;
    let cost = 0;

    const missedIdx: number[] = [];
    const missedTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (cached[i] === undefined) {
        missedIdx.push(i);
        missedTexts.push(texts[i]);
      }
    }

    if (missedTexts.length > 0) {
      const providerStart = Date.now();
      const embedded = await handler.embedUncached(missedTexts, {
        taskType: req.taskType,
        allowFallback: req.allowFallback,
      });
      const providerMs = Date.now() - providerStart;
      providerDurationSeconds
        .labels({ model: req.model, provider: embedded.provider })
        .observe(providerMs / 1000);
      textsTotal.inc({ model: req.model, source: 'provider', provider: embedded.provider }, missedTexts.length);

      if (embedded.vectors.length !== missedTexts.length) {
        throw new Error(`handler returned ${embedded.vectors.length} vectors for ${missedTexts.length} texts`);
      }
      for (let j = 0; j < missedIdx.length; j++) {
        vectors[missedIdx[j]] = embedded.vectors[j];
      }
      provider = embedded.provider;
      inputTokens = embedded.inputTokens;
      cost = embedded.cost;

      if (!bypassCache) {
        const pairs = missedTexts.map((text, j) => ({ text, vector: embedded.vectors[j] }));
        await this.cache.mset(req.model, dim, pairs);
        cacheOpsTotal.inc({ op: 'set', outcome: 'ok' }, pairs.length);
      } else {
        cacheOpsTotal.inc({ op: 'set', outcome: 'bypass' }, missedTexts.length);
      }
    }

    const finalVectors = vectors.map((v, i) => {
      if (!v) throw new Error(`missing vector at index ${i} after embed`);
      return v;
    });

    return {
      vectors: finalVectors,
      model: req.model,
      dimensions: dim,
      provider,
      cached: cached.map((v) => v !== undefined),
      inputTokens,
      cost,
    };
  }
}
