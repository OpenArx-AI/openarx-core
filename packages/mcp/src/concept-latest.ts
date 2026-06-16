/**
 * GET /api/internal/concept-latest — current latest version in a concept.
 *
 * Powers Portal's §19 stale-parent check (openarx-portal-atrj, Core bead
 * openarx-yurz): a version-bound draft (draft.previous_document_id IS NOT NULL)
 * is stale at publish-click iff its parent is no longer the latest version in
 * the concept — Core mints version = latest.version + 1, so publishing against a
 * stale parent must be refused (Portal returns 409 stale_parent, draft kept).
 *
 * concept_id is shared across all versions of a concept (migration 015 backfills
 * concept_id = id; create_new_version inherits it), so "latest" is simply
 * MAX(version) among non-deleted documents owned by the caller in that concept.
 * Owner-scoping means a concept the caller does not own returns 404 (no
 * existence leak), consistent with the other internal document endpoints.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal structural pool — pg Pool satisfies it, and tests can mock it. */
export interface QueryablePool {
  query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export interface ConceptLatestResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Resolve the latest version in a concept for an owner. Returns the HTTP status
 * + JSON body the route should send. Pure apart from the injected pool, so the
 * status/body contract is unit-testable without a live DB.
 */
export async function resolveConceptLatest(
  pool: QueryablePool,
  conceptId: string,
  userId: string,
): Promise<ConceptLatestResult> {
  if (!UUID_RE.test(conceptId) || !UUID_RE.test(userId)) {
    return { status: 400, body: { error: 'bad_request', message: 'concept_id and user_id (both UUID) are required' } };
  }
  try {
    const { rows } = await pool.query<{ id: string; version: number; title: string }>(
      `SELECT id::text AS id, version, title
         FROM documents
        WHERE concept_id = $1::uuid AND publisher_user_id = $2::uuid AND deleted_at IS NULL
        ORDER BY version DESC
        LIMIT 1`,
      [conceptId, userId],
    );
    if (rows.length === 0) {
      return { status: 404, body: { error: 'concept_not_found', message: 'no document in this concept owned by user_id' } };
    }
    return { status: 200, body: { id: rows[0].id, version: rows[0].version, title: rows[0].title } };
  } catch (err) {
    console.error('[concept-latest] DB error:', err instanceof Error ? err.message : err);
    return { status: 503, body: { error: 'concept_latest_unavailable', message: 'document store unavailable' } };
  }
}
