// ── read-graph v1 (retrieval · deterministic) ────────────────────────────────
//
// goal: a well-defined, schema-driven projection of the graph (read-harness).
// in: { query, projection } · out: { graph_view } · access: graph · effects: none.
// §12.7: each record's read shape comes from its type's `read` schema block (strip_fields
// + pointer_when — a non-distributable excerpt is a source pointer, never verbatim). The
// graph read handle returns the record's type; a per-type schema keys the projection off it.
// §12.5-bis (I2): a GENERAL process-id strip runs FIRST so a denormed run_id (indexed for
// internal queryability) never reaches the agent — on THIS read path too, not only
// scientific-reads. Then the caller's field allow-list applies.

import { definePrimitive, type Registration } from '../../runtime/index.js';
import { applyReadSchema, stripProcessIds, type ReadSchema } from '../../adapters/read-projection.js';

interface RecordSchema {
  read?: ReadSchema;
}
interface GraphRecord {
  id: string;
  record_type?: string;
  [field: string]: unknown;
}
interface In {
  query: { ids: string[] };
  projection: { fields: string[] };
}
interface ProjectedRecord {
  id: string;
  [field: string]: unknown;
}
interface Out {
  graph_view: ProjectedRecord[];
}

/** read-graph needs the record_schemas registry to key the per-type read projection. */
export function makeReadGraph(recordSchemas: Record<string, RecordSchema> = {}): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'read-graph',
      version: 'v1',
      kind: 'retrieval',
      goal: 'project graph records via each type’s read schema, enforcing process-id strip + non-distribution',
      access: ['graph'],
      effects: [],
      determinism: 'deterministic',
    },
    async ({ inputs, ctx }) => {
      const graph = ctx.read('graph');
      const graph_view: ProjectedRecord[] = [];
      for (const id of inputs.query.ids) {
        const got = (await graph.get(id)) as GraphRecord | undefined;
        if (!got) continue;
        const { record_type, ...record } = got;
        // 1) general process-id strip (run_id etc. never agent-facing, §12.5-bis).
        const stripped = stripProcessIds(record);
        // 2) the record type's read schema (strip_fields + pointer_when, §12.7).
        const shaped = applyReadSchema(stripped, record_type ? recordSchemas[record_type]?.read : undefined);
        // 2b) GENERAL non-distribution safety (defense-in-depth, schema or not): a
        // non-distributable verbatim excerpt NEVER leaves — always a source pointer. The
        // claim schema also declares this (pointer_when), but the invariant is enforced here
        // unconditionally so a missing/other schema can never leak an excerpt.
        if (record.distributable === false && 'excerpt' in shaped) {
          const e = shaped.excerpt;
          const alreadyPointer = e != null && typeof e === 'object' && 'pointer' in (e as Record<string, unknown>);
          if (!alreadyPointer) shaped.excerpt = { pointer: (typeof record.source_uri === 'string' ? record.source_uri : null) };
        }
        // 3) the caller's field allow-list.
        const projected: ProjectedRecord = { id: (typeof shaped.id === 'string' ? shaped.id : (record.id as string)) };
        for (const field of inputs.projection.fields) {
          if (field === 'id') continue;
          if (field in shaped) projected[field] = shaped[field];
        }
        graph_view.push(projected);
      }
      return { outputs: { graph_view } };
    },
  );
}
