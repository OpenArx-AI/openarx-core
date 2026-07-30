/**
 * backfill-embed-cap — mark chunks whose EMBED INPUT was capped during the Stage-1 qwen
 * re-embed (epic openarx-lsqk / openarx-6d10; contracts §5 operational-policy cond-(d)).
 *
 * The bulk ran with `--max-embed-tokens 1024`: reprocess-qwen built each chunk's embed input
 * with buildEmbedInput() and truncated it to `maxTokens * 4` CHARACTERS before sending it to
 * the model. The stored chunk text was never touched, so which chunks were capped is
 * deterministically recomputable after the fact — that is what this backfill does, writing
 * `chunks.embed_input_cap_tokens = <cap>` (NULL = the input was not capped).
 *
 * WHY IN SQL, NOT IN JS: the exact same predicate could be evaluated by importing
 * buildEmbedInput() here, but that would stream the full text of ~36M chunks (~100 GB) to
 * this process. The predicate below reproduces buildEmbedInput() byte-for-byte in SQL and
 * touches no data outside the server. Any change to buildEmbedInput() MUST be mirrored here.
 *
 * ── The predicate (mirrors migrate-embeddings-lib.buildEmbedInput) ──
 *   summary && keyConcept  ->  `${title}. ${section}. [${keyConcept}] ${summary}\n${content}`
 *   otherwise              ->  `${title}. ${section}. ${content}`
 *   title   = context.documentTitle ?? ''
 *   section = context.sectionPath ?? context.sectionName ?? ''
 * JS `&&` treats '' as falsy -> nullif(...,'') in SQL. JS `??` falls through only on
 * null/undefined -> coalesce() over ->> (which yields NULL for a missing key or JSON null).
 *
 * ── Length is measured in UTF-16 code units, exactly like JS `String.length` ──
 * Postgres length() counts CHARACTERS, so a non-BMP character (emoji, rare CJK, some math
 * symbols) counts 1 in SQL but 2 in JS. Correcting every row would mean a regexp over the
 * whole corpus, so the correction is applied only where it can possibly change the verdict:
 *   - len > maxChars                     -> capped regardless of any correction
 *   - len < maxChars/2                   -> cannot reach maxChars even if every char is
 *                                           non-BMP (utf16 <= 2*len), so never capped
 *   - maxChars/2 <= len <= maxChars      -> compute the exact UTF-16 length
 * This is exact, not an approximation, and the expensive branch sees a thin band of rows.
 *
 * Batched by document (keyset over documents.id) and committed per batch: resumable,
 * interruptible, no long-running transaction over a 36M-row table. Idempotent — re-running
 * only re-sets the same marker on the same rows.
 *
 *   pnpm --filter @openarx/ingest run backfill-embed-cap -- --dry-run
 *   pnpm --filter @openarx/ingest run backfill-embed-cap -- --cap-tokens 1024
 */
import { query } from '@openarx/api';

const CHARS_PER_TOKEN = 4; // must match reprocess-qwen.ts

interface Args {
  capTokens: number;
  batchDocs: number;
  dryRun: boolean;
  limitDocs: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (f: string, d: number | null): number | null => {
    const v = get(f);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${f} must be a positive number`);
    return n;
  };
  return {
    capTokens: num('--cap-tokens', 1024) ?? 1024,
    batchDocs: num('--batch-docs', 500) ?? 500,
    dryRun: argv.includes('--dry-run'),
    limitDocs: num('--limit-docs', null),
  };
}

/** buildEmbedInput() rebuilt in SQL (see the header note on why). */
const EMBED_INPUT_SQL = `
  CASE
    WHEN nullif(c.context->>'summary','') IS NOT NULL
     AND nullif(c.context->>'keyConcept','') IS NOT NULL
    THEN coalesce(c.context->>'documentTitle','') || '. '
      || coalesce(c.context->>'sectionPath', c.context->>'sectionName', '') || '. ['
      || (c.context->>'keyConcept') || '] ' || (c.context->>'summary') || E'\\n' || c.content
    ELSE coalesce(c.context->>'documentTitle','') || '. '
      || coalesce(c.context->>'sectionPath', c.context->>'sectionName', '') || '. ' || c.content
  END`;

/** JS String.length (UTF-16 code units) of the embed input, computed only where it matters. */
function cappedPredicate(maxChars: number): string {
  const s = `(${EMBED_INPUT_SQL})`;
  const len = `length${s}`;
  // non-BMP chars count twice in UTF-16; count them only inside the decision band.
  const utf16 = `(${len} + (${len} - length(regexp_replace(${s}, '[\\U00010000-\\U0010FFFF]', '', 'g'))))`;
  return `(${len} > ${maxChars} OR (${len} >= ${Math.floor(maxChars / 2)} AND ${utf16} > ${maxChars}))`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const maxChars = args.capTokens * CHARS_PER_TOKEN;
  const predicate = cappedPredicate(maxChars);

  console.log(
    JSON.stringify({
      stage: args.dryRun ? 'dry-run' : 'backfill',
      capTokens: args.capTokens,
      maxChars,
      batchDocs: args.batchDocs,
      limitDocs: args.limitDocs,
    }),
  );

  let lastDocId: string | null = null;
  let docsSeen = 0;
  let marked = 0;
  const started = Date.now();

  for (;;) {
    // Keyset over ALL documents; the CHUNK-level predicate decides what carries cap information.
    // NB the selection criterion is chunk-level (`recovery_status IS NOT NULL` = this chunk was
    // embedded by the qwen pass), NOT the document marker `qwen_reembed_at`. The document marker
    // is deliberately left unset for non-ready documents whose chunks were repaired by
    // reembed-stale-768 (so that a repaired document still gets re-processed later), so keying off
    // it would silently miss those chunks — exactly the coverage hole cond-(d) exists to prevent.
    const docRows: Array<{ id: string }> = (
      await query<{ id: string }>(
        `SELECT id::text AS id
           FROM documents
          WHERE ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2`,
        [lastDocId, args.batchDocs],
      )
    ).rows;
    if (docRows.length === 0) break;
    const ids: string[] = docRows.map((r) => r.id);
    lastDocId = ids[ids.length - 1];
    docsSeen += ids.length;

    if (args.dryRun) {
      const r = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chunks c
          WHERE c.document_id = ANY($1::uuid[])
            AND c.recovery_status IS NOT NULL
            AND ${predicate}`,
        [ids],
      );
      marked += parseInt(r.rows[0]?.n ?? '0', 10);
    } else {
      // Idempotent: IS DISTINCT FROM keeps a re-run from rewriting rows already marked.
      const r = await query(
        `UPDATE chunks c
            SET embed_input_cap_tokens = $2::int
          WHERE c.document_id = ANY($1::uuid[])
            AND c.recovery_status IS NOT NULL
            AND c.embed_input_cap_tokens IS DISTINCT FROM $2::int
            AND ${predicate}`,
        [ids, args.capTokens],
      );
      marked += r.rowCount ?? 0;
    }

    if (docsSeen % (args.batchDocs * 20) === 0) {
      const mins = (Date.now() - started) / 60000;
      console.log(
        JSON.stringify({ docsSeen, marked, docsPerMin: Math.round(docsSeen / Math.max(mins, 0.01)) }),
      );
    }
    if (args.limitDocs !== null && docsSeen >= args.limitDocs) break;
  }

  console.log(
    JSON.stringify({
      stage: 'complete',
      docsSeen,
      chunksMarked: marked,
      capTokens: args.capTokens,
      minutes: +((Date.now() - started) / 60000).toFixed(1),
    }),
  );
  process.exit(0);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
