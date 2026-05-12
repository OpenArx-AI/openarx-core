/**
 * openarx reprocess — reset documents for re-processing.
 *
 * Flags:
 *   --all                 All ready documents
 *   --quality-below N     Documents with parse_quality < N
 *   --parser <name>       Documents parsed with specific parser
 *   --source-id <id>      Single document by source_id
 *   --dry-run             Show what would be reprocessed, no changes
 *   --limit N             Max documents to reprocess (default 100)
 */

import { query, QdrantVectorStore } from '@openarx/api';

interface DocRow {
  id: string;
  source_id: string;
  title: string;
  parser_used: string | null;
  parse_quality: string | null;
  quality_flags: Record<string, unknown> | null;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

export async function reprocess(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const qualityBelow = parseFlag(args, '--quality-below');
  const parser = parseFlag(args, '--parser');
  const sourceId = parseFlag(args, '--source-id');
  const limit = parseInt(parseFlag(args, '--limit') ?? '100', 10);

  if (!all && !qualityBelow && !parser && !sourceId) {
    console.error('Specify one of: --all, --quality-below N, --parser <name>, --source-id <id>');
    console.log('\nUsage: openarx reprocess [--dry-run] [--limit N] <filter>');
    process.exit(1);
  }

  // Build query based on filter
  let whereClause: string;
  const params: unknown[] = [];

  if (sourceId) {
    whereClause = "source_id = $1 AND status = 'ready'";
    params.push(sourceId);
  } else if (qualityBelow) {
    whereClause = "status = 'ready' AND parse_quality < $1";
    params.push(parseFloat(qualityBelow));
  } else if (parser) {
    whereClause = "status = 'ready' AND parser_used = $1";
    params.push(parser);
  } else {
    whereClause = "status = 'ready'";
  }

  const { rows: docs } = await query<DocRow>(
    `SELECT id, source_id, title, parser_used, parse_quality, quality_flags
     FROM documents WHERE ${whereClause}
     ORDER BY parse_quality ASC NULLS FIRST
     LIMIT $${params.length + 1}`,
    [...params, limit],
  );

  if (docs.length === 0) {
    console.log('No matching documents found.');
    return;
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Found ${docs.length} documents to reprocess:\n`);
  for (const doc of docs) {
    const quality = doc.parse_quality != null ? parseFloat(doc.parse_quality).toFixed(3) : 'N/A';
    console.log(`  ${doc.source_id}  quality=${quality}  parser=${doc.parser_used ?? 'N/A'}  "${doc.title.slice(0, 60)}"`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would reset ${docs.length} documents. Run without --dry-run to execute.`);
    return;
  }

  // Qdrant cleanup via VectorStore (IndexerStep also cleans on re-index, this is belt-and-suspenders)
  const vectorStore = new QdrantVectorStore();

  let resetCount = 0;
  for (const doc of docs) {
    try {
      // 1. Delete chunks from PostgreSQL
      const { rowCount } = await query('DELETE FROM chunks WHERE document_id = $1', [doc.id]);

      // 2. Delete from Qdrant (non-fatal — IndexerStep will also clean on re-index)
      try {
        // Use getByDocumentId to trigger scroll, but we just need the delete.
        // Qdrant delete-by-filter via internal client would be ideal,
        // but we can trigger cleanup by letting IndexerStep handle it on re-run.
        // For immediate cleanup, use the same pattern as IndexerStep:
        await vectorStore.deleteByDocumentId(doc.id);
      } catch {
        // Non-fatal — IndexerStep handles cleanup on re-run
      }

      // 3. Save previous quality info, reset document
      const previousParse = {
        parse_quality: doc.parse_quality,
        parser_used: doc.parser_used,
        quality_flags: doc.quality_flags,
      };

      await query(
        `UPDATE documents SET
           status = 'downloaded',
           parse_quality = NULL,
           math_density = NULL,
           parser_used = NULL,
           quality_flags = $1,
           processing_log = '[]',
           provenance = COALESCE(provenance, '[]'::jsonb) || $2::jsonb
         WHERE id = $3`,
        [
          JSON.stringify({ previous_parse: previousParse }),
          JSON.stringify([{ op: 'reprocess', at: new Date().toISOString(), commit: 'cli' }]),
          doc.id,
        ],
      );

      resetCount++;
      console.log(`  [OK] ${doc.source_id} — deleted ${rowCount} chunks, reset to downloaded`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERR] ${doc.source_id} — ${msg}`);
    }
  }

  console.log(`\nDone: ${resetCount}/${docs.length} documents reset to 'downloaded'.`);
  console.log('Run "openarx ingest run --concurrency 3" to re-process them.');
}
