/**
 * Document path resolution — 2-level directory structure to prevent
 * flat directory degradation on SSHFS (100K+ dirs = slow readdir).
 *
 * arXiv:  /arxiv/{YY}/{MM}/{arxivId}/          e.g. /arxiv/25/10/2510.26684/
 * Portal: /portal-docs/{userId}/indexed/{docId}/  e.g. /portal-docs/3b83.../indexed/a1b2.../
 */

import { join } from 'node:path';

const ARXIV_DATA_DIR = process.env.RUNNER_DATA_DIR ?? '/mnt/storagebox/arxiv';
const PORTAL_STORAGE_BASE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';

// ─── arXiv ────────────────────────────────────────────────────

/** Parse YYMM prefix from arxivId (e.g. "2510.26684" → { yy: "25", mm: "10" }) */
function parseArxivPrefix(arxivId: string): { yy: string; mm: string } | null {
  const match = arxivId.match(/^(\d{2})(\d{2})\./);
  return match ? { yy: match[1], mm: match[2] } : null;
}

/** 2-level path for arXiv doc: /arxiv/YY/MM/arxivId/. Flat fallback for non-standard IDs. */
export function arxivDocPath(arxivId: string, dataDir?: string): string {
  const base = dataDir ?? ARXIV_DATA_DIR;
  const prefix = parseArxivPrefix(arxivId);
  if (!prefix) return join(base, arxivId);
  return join(base, prefix.yy, prefix.mm, arxivId);
}

// ─── Portal ───────────────────────────────────────────────────

/** Per-user path for Portal indexed docs: /portal-docs/{userId}/indexed/{docId}/ */
export function portalDocPath(userId: string, docId: string, storageBase?: string): string {
  const base = storageBase ?? PORTAL_STORAGE_BASE;
  return join(base, userId, 'indexed', docId);
}
