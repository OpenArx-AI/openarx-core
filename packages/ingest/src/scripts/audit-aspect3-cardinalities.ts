/**
 * Read-only audit: FULL Aspect-3 similar / cited cardinalities for one document.
 *
 * The stored document_reviews.similar_documents JSONB keeps only the TOP_N=10
 * display slice. This script replicates the novelty-worker sweep verbatim
 * (stride-sampled ≤SAMPLE_CAP chunks × K_NEIGHBOURS Qdrant neighbours on the
 * gemini vector, concept self-filter, aggregate, T_OVERLAP cut) to report the
 * FULL |similar| set, the grounding numerator |cited ∩ similar|, the is_cited
 * split, and the similarity-band histogram.
 *
 * NO WRITES — Qdrant scroll/search + PG SELECT only. For IdeaRank baseline
 * (msi:openarx-research, contracts audit 20260615-212937-0041).
 *
 * Usage: tsx src/scripts/audit-aspect3-cardinalities.ts <documentId> <conceptId>
 */
import type { ParsedReference } from '@openarx/types';
import { QdrantVectorStore, query } from '@openarx/api';
import {
  strideSample,
  aggregateSimilarDocs,
  extractCitedIdentifiers,
  extractIdentifiersFromText,
  K_NEIGHBOURS,
  T_OVERLAP,
  T_DUP,
  SAMPLE_CAP,
} from '../pipeline/review/novelty-worker.js';

const DOC_ID = process.argv[2] ?? 'ba946e26-1977-4d91-b443-0c684a33efe0';
const CONCEPT_ID = process.argv[3] ?? '5127a4a1-34dd-4b19-afa2-d49c06e6f7cc';

function asReferences(sc: unknown): ParsedReference[] {
  if (sc && typeof sc === 'object' && Array.isArray((sc as { references?: unknown }).references)) {
    return (sc as { references: ParsedReference[] }).references;
  }
  return [];
}

async function main(): Promise<void> {
  const vs = new QdrantVectorStore();

  // 1. The document's chunks with gemini vectors (Qdrant scroll, with_vector).
  const chunks = await vs.getByDocumentId(DOC_ID);
  const withVec = chunks.filter((c) => Array.isArray(c.vectors?.gemini) && c.vectors.gemini.length > 0);
  const samples = strideSample(withVec, SAMPLE_CAP);
  console.log(`doc=${DOC_ID} concept=${CONCEPT_ID}`);
  console.log(`chunks=${chunks.length} withGeminiVector=${withVec.length} sampled=${samples.length} (cap ${SAMPLE_CAP}, K=${K_NEIGHBOURS})`);

  // 2. Batched K-NN with self-concept exclusion (verbatim novelty-worker step 2).
  const batchResults = await vs.batchSearch(
    samples.map((c) => ({
      vector: c.vectors.gemini,
      vectorName: 'gemini',
      filter: { must_not: [{ key: 'concept_id', match: { value: CONCEPT_ID } }] },
      limit: K_NEIGHBOURS,
    })),
  );

  // 3. Aggregate → FULL similar set above T_OVERLAP (this is what grounding uses).
  const agg = aggregateSimilarDocs(batchResults, T_DUP);
  const similar = [...agg.values()].filter((x) => x.maxSim >= T_OVERLAP);
  const similarIds = new Set(similar.map((x) => x.documentId));

  // 4. Cited resolution (verbatim novelty-worker step 3): structured refs +
  //    body text + raw ref strings → identifiers → documents lookup.
  const { rows: drows } = await query<{ structured_content: unknown }>(
    'SELECT structured_content FROM documents WHERE id = $1::uuid',
    [DOC_ID],
  );
  const references = asReferences(drows[0]?.structured_content);
  const bodyText = chunks.map((c) => c.content ?? '').join('\n');
  const refsText = references.map((r) => `${r.raw ?? ''} ${r.url ?? ''} ${r.doi ?? ''}`).join('\n');
  const fromStructured = extractCitedIdentifiers(references);
  const fromText = extractIdentifiersFromText(`${bodyText}\n${refsText}`);
  const dois = [...new Set([...fromStructured.dois, ...fromText.dois])];
  const arxivIds = [...new Set([...fromStructured.arxivIds, ...fromText.arxivIds])];
  const oarxIds = fromText.oarxIds;
  const citedDocIds = new Set<string>();
  if (dois.length > 0 || arxivIds.length > 0 || oarxIds.length > 0) {
    const { rows } = await query<{ id: string }>(
      `SELECT id::text AS id FROM documents
       WHERE (external_ids->>'doi') = ANY($1::text[])
          OR source_id = ANY($2::text[])
          OR (external_ids->>'arxiv_id') = ANY($2::text[])
          OR oarx_id = ANY($3::text[])
          OR left(oarx_id, 13) = ANY($3::text[])`,
      [dois, arxivIds, oarxIds],
    );
    for (const r of rows) citedDocIds.add(r.id);
  }
  const citedInSimilar = [...similarIds].filter((id) => citedDocIds.has(id));

  // 5. Similarity-band histogram over the FULL similar set.
  const bands = { b75_80: 0, b80_85: 0, b85_90: 0, bge90: 0 };
  for (const s of similar) {
    if (s.maxSim >= 0.9) bands.bge90 += 1;
    else if (s.maxSim >= 0.85) bands.b85_90 += 1;
    else if (s.maxSim >= 0.8) bands.b80_85 += 1;
    else bands.b75_80 += 1;
  }

  const denom = similar.length;
  const num = citedInSimilar.length;
  const sims = similar.map((s) => s.maxSim);
  console.log('───────── RESULTS ─────────');
  console.log(`item1  |similar| (distinct ext docs, maxSim≥${T_OVERLAP}) = ${denom}`);
  console.log(`item2  |cited ∩ similar| (grounding numerator)            = ${num}`);
  console.log(`item3  is_cited within similar: true=${num}  false=${denom - num}`);
  console.log(`item4  bands  0.75–0.80=${bands.b75_80}  0.80–0.85=${bands.b80_85}  0.85–0.90=${bands.b85_90}  ≥0.90=${bands.bge90}`);
  console.log('───────── cross-checks ─────────');
  console.log(`grounding = num/denom = ${denom ? (num / denom).toFixed(4) : 'n/a'}  (stored review = 0.07)`);
  console.log(`cited identifiers extracted: dois=${dois.length} arxiv=${arxivIds.length} oarx=${oarxIds.length}; full citedSet size=${citedDocIds.size}`);
  console.log(`structured_content references present: ${references.length}`);
  console.log(`maxSim range: ${sims.length ? `${Math.min(...sims).toFixed(4)}–${Math.max(...sims).toFixed(4)}` : 'n/a'}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
