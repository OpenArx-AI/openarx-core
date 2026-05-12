/**
 * test-atom-filters — explore what arXiv Atom search API accepts as
 * unfiltered or all-CS queries. Goal: find a search_query that returns
 * ALL CS papers (any subcategory) for a given submission date — to make
 * coverage_map fillable for non-AI/ML cats while keeping Atom's exact
 * submission-date semantics.
 *
 * Tries variants:
 *   V1. submittedDate alone (no cat filter)
 *   V2. all:* + submittedDate (boolean wildcard)
 *   V3. cat:cs.* (prefix wildcard, likely unsupported)
 *   V4. Full enumeration of all CS sub-categories in OR
 *
 * For each: report HTTP status, totalResults, first few entry IDs.
 *
 * Read-only network probe.
 */

import { initProxyPool } from '../lib/proxy-pool.js';

const ARXIV_API = 'https://export.arxiv.org/api/query';

// Comprehensive list of all CS sub-categories on arxiv (per arxiv.org taxonomy)
const ALL_CS_CATS = [
  'cs.AI', 'cs.AR', 'cs.CC', 'cs.CE', 'cs.CG', 'cs.CL', 'cs.CR', 'cs.CV',
  'cs.CY', 'cs.DB', 'cs.DC', 'cs.DL', 'cs.DM', 'cs.DS', 'cs.ET', 'cs.FL',
  'cs.GL', 'cs.GR', 'cs.GT', 'cs.HC', 'cs.IR', 'cs.IT', 'cs.LG', 'cs.LO',
  'cs.MA', 'cs.MM', 'cs.MS', 'cs.NA', 'cs.NE', 'cs.NI', 'cs.OH', 'cs.OS',
  'cs.PF', 'cs.PL', 'cs.RO', 'cs.SC', 'cs.SD', 'cs.SE', 'cs.SI', 'cs.SY',
];

interface ParsedEntry {
  arxivId: string;
  publishedAt: string;  // ISO timestamp from <published>
  categories: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface VariantResult {
  name: string;
  totalResults: number;
  entries: ParsedEntry[];
  matchTargetDate: number;
  outsideTargetDate: number;
  uniqueCats: Set<string>;
  topLevelGroups: Map<string, number>;  // 'cs' / 'math' / 'physics' / etc → count
}

async function fetchAndParseAll(name: string, baseUrl: string, targetDay: string): Promise<VariantResult> {
  console.log(`\n=== ${name} ===`);
  const entries: ParsedEntry[] = [];
  let totalResults = 0;
  let start = 0;
  const pageSize = 200;
  const maxPages = 20;
  let pages = 0;

  while (pages < maxPages) {
    pages++;
    const url = `${baseUrl}&start=${start}&max_results=${pageSize}`;
    let xml: string;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) {
        console.log(`  page ${pages}: HTTP ${resp.status}, stopping`);
        break;
      }
      xml = await resp.text();
    } catch (err) {
      console.log(`  page ${pages}: ERROR ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    if (pages === 1) {
      const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/) ?? xml.match(/<totalResults[^>]*>(\d+)<\/totalResults>/);
      totalResults = totalMatch ? parseInt(totalMatch[1], 10) : -1;
    }

    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let m: RegExpExecArray | null;
    let pageEntries = 0;
    while ((m = entryRegex.exec(xml)) !== null) {
      const block = m[1];
      const idM = block.match(/<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
      if (!idM) continue;
      const arxivId = idM[1].replace(/v\d+$/, '');
      const pubM = block.match(/<published>([^<]+)<\/published>/);
      const publishedAt = pubM ? pubM[1] : '';
      const cats = [...block.matchAll(/<category[^/]+term="([^"]+)"/g)].map((cm) => cm[1]);
      entries.push({ arxivId, publishedAt, categories: cats });
      pageEntries++;
    }

    console.log(`  page ${pages}: got ${pageEntries} entries (total so far ${entries.length}, totalResults=${totalResults})`);
    if (pageEntries === 0) break;
    if (entries.length >= totalResults) break;
    start += pageSize;
    await sleep(3000);  // arxiv rate limit
  }

  // Analyze
  let matchTargetDate = 0;
  let outsideTargetDate = 0;
  const uniqueCats = new Set<string>();
  const topLevelGroups = new Map<string, number>();
  for (const e of entries) {
    if (e.publishedAt.slice(0, 10) === `${targetDay.slice(0, 4)}-${targetDay.slice(4, 6)}-${targetDay.slice(6, 8)}`) {
      matchTargetDate++;
    } else {
      outsideTargetDate++;
    }
    for (const c of e.categories) {
      uniqueCats.add(c);
      const grp = c.split('.')[0];
      topLevelGroups.set(grp, (topLevelGroups.get(grp) ?? 0) + 1);
    }
  }

  return { name, totalResults, entries, matchTargetDate, outsideTargetDate, uniqueCats, topLevelGroups };
}

function summarize(r: VariantResult): void {
  console.log(`\n  Summary [${r.name}]:`);
  console.log(`    totalResults reported by API: ${r.totalResults}`);
  console.log(`    fetched entries:              ${r.entries.length}`);
  console.log(`    match target submitted date:  ${r.matchTargetDate}`);
  console.log(`    OUTSIDE target date:          ${r.outsideTargetDate} ← unexpected`);
  console.log(`    unique categories:            ${r.uniqueCats.size}`);
  const groups = [...r.topLevelGroups.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`    top-level groups (cat counts, can sum > entries due to cross-listing):`);
  for (const [grp, n] of groups.slice(0, 10)) {
    console.log(`      ${grp.padEnd(8)} ${n}`);
  }
}

async function main(): Promise<void> {
  const day = process.argv[2] && /^\d{8}$/.test(process.argv[2]) ? process.argv[2] : '20240115';
  console.log(`test-atom-filters: full pagination — day=${day}\n`);
  initProxyPool();

  const dateRange = `submittedDate:%5B${day}+TO+${day}%5D`;
  const sortSuffix = `&sortBy=submittedDate&sortOrder=descending`;

  // V1a — no cat filter, full arxiv
  const v1a = await fetchAndParseAll(
    'V1a. submittedDate alone (full arxiv)',
    `${ARXIV_API}?search_query=${dateRange}${sortSuffix}`,
    day,
  );
  summarize(v1a);

  // V0 — baseline cs.AI/CL/LG for sanity check
  const v0 = await fetchAndParseAll(
    'V0. cs.AI/CL/LG baseline',
    `${ARXIV_API}?search_query=%28cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG%29+AND+${dateRange}${sortSuffix}`,
    day,
  );
  summarize(v0);

  // Cross-check: is V0 a strict subset of V1a?
  console.log('\n=== Cross-check: V0 ⊆ V1a? ===');
  const v1aIds = new Set(v1a.entries.map((e) => e.arxivId));
  const v0InV1a = v0.entries.filter((e) => v1aIds.has(e.arxivId)).length;
  const v0NotInV1a = v0.entries.filter((e) => !v1aIds.has(e.arxivId)).length;
  console.log(`  V0 entries IN V1a:  ${v0InV1a}`);
  console.log(`  V0 entries NOT IN V1a: ${v0NotInV1a} ← (should be 0 if V1a is comprehensive)`);
  if (v0NotInV1a > 0) {
    const missing = v0.entries.filter((e) => !v1aIds.has(e.arxivId)).slice(0, 5).map((e) => e.arxivId);
    console.log(`    sample missing: ${missing.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
