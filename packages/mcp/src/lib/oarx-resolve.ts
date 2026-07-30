import { OARX_ID_RE, LEGACY_OARX_ID_RE } from '@openarx/api';

/** Minimal structural pool — satisfied by pg.Pool (ctx.pool) and by test stubs. */
interface QueryablePool {
  query<R = unknown>(text: string, values: unknown[]): Promise<{ rows: R[] }>;
}

export type OarxResolveResult =
  | { status: 'ok'; docId: string }
  | { status: 'invalid' }
  | { status: 'not_found' };

/**
 * CANONICAL oarx-id → document UUID resolution — the single source of truth shared by the
 * `find_by_id` MCP tool (agent-facing) and the `GET /documents/by-oarx-id/:oarxId` internal
 * REST route (Portal smart-search). Consistency is further guaranteed by the UNIQUE
 * `idx_documents_oarx_id` index.
 *
 * 16-hex `oarx-<sha>` matches the column exactly; legacy 8-hex `oarx-<sha8>` matches via
 * `left(oarx_id, 13)` (migration 029 expression index — the legacy id is a prefix of the new
 * one, same sha256). Listed (registry-stub, files not downloaded) and soft-deleted docs stay
 * invisible, consistent with every id-lookup path.
 */
export async function resolveOarxIdToDocId(pool: QueryablePool, oarxId: string): Promise<OarxResolveResult> {
  const id = oarxId.trim().toLowerCase();
  let cond: string;
  if (OARX_ID_RE.test(id)) cond = 'oarx_id = $1';
  else if (LEGACY_OARX_ID_RE.test(id)) cond = 'left(oarx_id, 13) = $1';
  else return { status: 'invalid' };
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM documents WHERE ${cond} AND deleted_at IS NULL AND status != 'listed' LIMIT 1`,
    [id],
  );
  return rows[0]?.id ? { status: 'ok', docId: rows[0].id } : { status: 'not_found' };
}
