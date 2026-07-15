// ── Layer 2 semantic layer — Qdrant collection `layer2_claims` (§5.4.1) ───────
//
// TWO named vectors per point (Vlad decision): gemini (3072) + specter2 (768)
// — insurance (specter2 is local) + different embedding-space natures. Model
// versions are pinned by the embed service; changing either = deliberate full
// reindex (bump PAYLOAD_SCHEMA_VERSION or reindex flag).
//
// Payload carries the categorical filter fields (§5.4.2 — NOT embedded into
// text) + provenance of the projection (payload_schema_version, text_hash) so
// the worker can skip re-embedding when the projection is unchanged and the
// consistency audit can find stale-schema points.
//
// Migration invariant (§5.4.5): this collection + sync path survive Phase 2.

import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';

export const LAYER2_COLLECTION = 'layer2_claims';

export interface ClaimPointPayload {
  claim_id: string;
  payload_schema_version: string;
  text_hash: string; // sha256 of the embedded projection text
  embedded_at: string;
  // categorical filters (§5.4.2)
  modality: string | null;
  claim_type: string | null;
  claim_status: string | null;
  verification_outcome: string | null; // null = unverified
  attester_id: string;
  run_id: string | null;
  is_superseded: boolean;
  attested_at: string;
  /** §12.9 P3: this claim participates in the engineering dependency graph (≥1 ENG_* edge). The
   *  eng-search read-filters on this so scope=engineering returns only engineering approaches, not
   *  text-similar non-engineering claims. Absent on legacy points (treated as false by the filter). */
  is_engineering_connected?: boolean;
}

export interface ClaimSearchHit {
  claimId: string;
  score: number;
  payload: ClaimPointPayload;
}

/** Deterministic Qdrant UUID for a claim id (uuid-v5-like from sha256). */
export function pointIdForClaim(claimId: string): string {
  const h = createHash('sha256').update(claimId, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function projectionTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class Layer2VectorStore {
  private readonly client: QdrantClient;

  constructor() {
    this.client = new QdrantClient({
      url: process.env.QDRANT_URL ?? 'http://localhost:6333',
      apiKey: process.env.QDRANT_API_KEY,
      checkCompatibility: false,
    });
  }

  /** Idempotent collection + payload-index setup. Safe on every startup. */
  async ensureCollection(): Promise<void> {
    const { collections } = await this.client.getCollections();
    if (!collections.some((c) => c.name === LAYER2_COLLECTION)) {
      const vectors: Record<string, { size: number; distance: 'Cosine' }> = {
        gemini: { size: 3072, distance: 'Cosine' }, // §7-scientific claim projection
        specter2: { size: 768, distance: 'Cosine' },
      };
      // §12.9 P3: the engineering-edge projection vector is added only when the feature is enabled, so a
      // fresh collection matches the deployed state (the live collection is migrated by the recreate op).
      if (process.env.LAYER2_ENG_VECTOR === 'true')
        vectors.gemini_eng = { size: 3072, distance: 'Cosine' };
      await this.client.createCollection(LAYER2_COLLECTION, { vectors });
    }
    const indexFields: Array<[string, 'keyword' | 'bool']> = [
      ['claim_id', 'keyword'],
      ['payload_schema_version', 'keyword'],
      ['modality', 'keyword'],
      ['claim_type', 'keyword'],
      ['claim_status', 'keyword'],
      ['verification_outcome', 'keyword'],
      ['attester_id', 'keyword'],
      ['run_id', 'keyword'],
      ['is_superseded', 'bool'],
      ['is_engineering_connected', 'bool'], // §12.9 P3 eng-search read-filter
    ];
    for (const [field, schema] of indexFields) {
      await this.client
        .createPayloadIndex(LAYER2_COLLECTION, {
          field_name: field,
          field_schema: schema,
          wait: true,
        })
        .catch(() => undefined); // already exists
    }
  }

  /** Fetch current text_hash for a point (skip-unchanged optimization). */
  async getPointTextHash(claimId: string): Promise<string | null> {
    const res = await this.client
      .retrieve(LAYER2_COLLECTION, { ids: [pointIdForClaim(claimId)], with_payload: true })
      .catch(() => []);
    const p = res[0]?.payload as ClaimPointPayload | undefined;
    return p?.text_hash ?? null;
  }

  async upsertClaimPoint(
    claimId: string,
    // specter2 is OPTIONAL: the methodist vectorize path (2c) writes gemini-only for now
    // (specter2 is a later schema-driven swap, out of the current spec). A point with just
    // the gemini named vector is valid — it's searchable by gemini. The live PG-embed
    // worker still passes BOTH, so its behaviour is unchanged.
    vectors: { gemini: number[]; specter2?: number[]; gemini_eng?: number[] },
    payload: ClaimPointPayload,
  ): Promise<void> {
    const vector: Record<string, number[]> = { gemini: vectors.gemini };
    if (vectors.specter2) vector.specter2 = vectors.specter2;
    if (vectors.gemini_eng) vector.gemini_eng = vectors.gemini_eng; // §12.9 P3 engineering projection
    await this.client.upsert(LAYER2_COLLECTION, {
      wait: true,
      points: [
        {
          id: pointIdForClaim(claimId),
          vector,
          payload: payload as unknown as Record<string, unknown>,
        },
      ],
    });
  }

  /** Payload-only update (e.g. verification_outcome / is_superseded changed
   *  while the projection text — and thus the vectors — did not). */
  async setClaimPayload(claimId: string, payload: ClaimPointPayload): Promise<void> {
    await this.client.setPayload(LAYER2_COLLECTION, {
      wait: true,
      points: [pointIdForClaim(claimId)],
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  async deleteClaimPoint(claimId: string): Promise<void> {
    await this.client.delete(LAYER2_COLLECTION, { wait: true, points: [pointIdForClaim(claimId)] });
  }

  async countPoints(): Promise<number> {
    const { count } = await this.client.count(LAYER2_COLLECTION, { exact: true });
    return count;
  }

  /** All claim_ids currently in the collection (consistency audit; scroll). */
  async listClaimIds(): Promise<Set<string>> {
    const out = new Set<string>();
    let offset: string | number | undefined | null = undefined;
    do {
      const res: Awaited<ReturnType<QdrantClient['scroll']>> = await this.client.scroll(
        LAYER2_COLLECTION,
        {
          limit: 1000,
          with_payload: { include: ['claim_id'] },
          with_vector: false,
          offset: offset ?? undefined,
        },
      );
      for (const p of res.points) {
        const cid = (p.payload as { claim_id?: string } | null)?.claim_id;
        if (cid) out.add(cid);
      }
      offset = res.next_page_offset as string | number | null;
    } while (offset !== null && offset !== undefined);
    return out;
  }

  /** Scroll ALL points with their named vectors + payload. Migration/audit use only
   *  (§12.9 P3 recreate reads this to preserve gemini/specter2 byte-exact across a
   *  collection recreate). HARDCODED to LAYER2_COLLECTION — never any other collection. */
  async scrollAllWithVectors(): Promise<
    Array<{ id: string | number; vector: Record<string, number[]>; payload: ClaimPointPayload }>
  > {
    const out: Array<{
      id: string | number;
      vector: Record<string, number[]>;
      payload: ClaimPointPayload;
    }> = [];
    let offset: string | number | undefined | null = undefined;
    do {
      const res: Awaited<ReturnType<QdrantClient['scroll']>> = await this.client.scroll(
        LAYER2_COLLECTION,
        {
          limit: 250,
          with_payload: true,
          with_vector: true,
          offset: offset ?? undefined,
        },
      );
      for (const p of res.points) {
        out.push({
          id: p.id,
          vector: (p.vector ?? {}) as Record<string, number[]>,
          payload: p.payload as unknown as ClaimPointPayload,
        });
      }
      offset = res.next_page_offset as string | number | null;
    } while (offset !== null && offset !== undefined);
    return out;
  }

  /** Drop the layer2_claims collection. Recreate-migration use only (§12.9 P3).
   *  HARDCODED to LAYER2_COLLECTION — cannot target `chunks` or any other collection. */
  async dropCollection(): Promise<void> {
    await this.client.deleteCollection(LAYER2_COLLECTION);
  }

  async searchClaims(
    vectorName: 'gemini' | 'specter2' | 'gemini_eng',
    vector: number[],
    filter: Record<string, unknown> | undefined,
    limit: number,
  ): Promise<ClaimSearchHit[]> {
    const results = await this.client.query(LAYER2_COLLECTION, {
      query: vector,
      using: vectorName,
      filter,
      limit,
      with_payload: true,
    });
    return results.points.map((p) => {
      const payload = p.payload as unknown as ClaimPointPayload;
      return { claimId: payload.claim_id, score: p.score ?? 0, payload };
    });
  }
}
