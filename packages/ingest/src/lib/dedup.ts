/**
 * Near-duplicate detection for documents via normalized title similarity.
 */

import { query } from '@openarx/api';

export interface DuplicatePair {
  docA: { id: string; sourceId: string; title: string; status: string };
  docB: { id: string; sourceId: string; title: string; status: string };
  similarity: number;
}

/** Lowercase, strip non-alphanumeric, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Wagner-Fischer Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use single-row optimization
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = row[j];
      row[j] = val;
    }
  }

  return row[n];
}

/** Normalized similarity: 1 - levenshtein(norm(a), norm(b)) / max(len(a), len(b)). */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);

  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;

  return 1 - levenshtein(na, nb) / maxLen;
}

/** Normalized text similarity without title-specific normalization. */
export function textSimilarity(a: string, b: string): number {
  const ta = a.trim();
  const tb = b.trim();

  if (ta === tb) return 1;
  const maxLen = Math.max(ta.length, tb.length);
  if (maxLen === 0) return 1;

  // For very long texts, compare prefixes to avoid O(n²) blowup
  if (maxLen > 2000) {
    const limit = 2000;
    return 1 - levenshtein(ta.slice(0, limit), tb.slice(0, limit)) / limit;
  }

  return 1 - levenshtein(ta, tb) / maxLen;
}

/** Find all document pairs with title similarity >= threshold. */
export async function findDuplicates(threshold = 0.95): Promise<DuplicatePair[]> {
  const result = await query<{
    id: string;
    source_id: string;
    title: string;
    status: string;
  }>(`SELECT id, source_id, title, status FROM documents ORDER BY created_at`);

  const docs = result.rows;
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const sim = titleSimilarity(docs[i].title, docs[j].title);
      if (sim >= threshold) {
        pairs.push({
          docA: {
            id: docs[i].id,
            sourceId: docs[i].source_id,
            title: docs[i].title,
            status: docs[i].status,
          },
          docB: {
            id: docs[j].id,
            sourceId: docs[j].source_id,
            title: docs[j].title,
            status: docs[j].status,
          },
          similarity: sim,
        });
      }
    }
  }

  return pairs;
}
